import { describe, expect, it, vi } from "vitest";
import type { PostgresPool } from "./postgres-iam-store.js";
import { PostgresFinancialJournalService } from "./postgres-financial-journal-service.js";

const input = {
  tenantId: "tenant-1",
  idempotencyKey: "capture-journal:order-1",
  sourceType: "payment_capture",
  sourceReference: "capture-1",
  currency: "SAR",
  description: "Initial customer payment capture",
  occurredAtUtc: "2026-11-14T12:00:00.000Z",
  lines: [
    { accountId: "cash-account", debitMinor: 10000 },
    { accountId: "merchant-payable", creditMinor: 9000 },
    { accountId: "platform-revenue", creditMinor: 1000 }
  ]
};

function serviceWith(query: ReturnType<typeof vi.fn>, createId = () => "journal-1") {
  const client = { query, release: vi.fn() };
  const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } as unknown as PostgresPool;
  return { service: new PostgresFinancialJournalService(pool, createId), client };
}

describe("PostgresFinancialJournalService", () => {
  it("writes all lines and posts the balanced journal in one transaction", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [{ id: "journal-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "journal-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: null });
    let id = 0;
    const { service, client } = serviceWith(query, () => `journal-${++id}`);
    await expect(service.post(input)).resolves.toEqual({ outcome: "posted", journalId: "journal-1" });
    expect(query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(query.mock.calls[1]?.[0]).toContain("ON CONFLICT (tenant_id,idempotency_key) DO NOTHING");
    expect(query.mock.calls.filter(call => String(call[0]).includes("INSERT INTO financial_journal_lines"))).toHaveLength(3);
    expect(query.mock.calls.at(-2)?.[0]).toContain("status='posted'");
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects an unbalanced journal before opening a database transaction", async () => {
    const query = vi.fn();
    const { service } = serviceWith(query);
    await expect(service.post({ ...input, lines: [
      { accountId: "cash-account", debitMinor: 10000 },
      { accountId: "revenue-account", creditMinor: 9999 }
    ] })).rejects.toThrow("FINANCIAL_JOURNAL_NOT_BALANCED");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a line with both debit and credit values", async () => {
    const query = vi.fn();
    const { service } = serviceWith(query);
    await expect(service.post({ ...input, lines: [
      { accountId: "cash-account", debitMinor: 100, creditMinor: 100 },
      { accountId: "revenue-account", creditMinor: 200 }
    ] })).rejects.toThrow("INVALID_FINANCIAL_JOURNAL_LINE");
    expect(query).not.toHaveBeenCalled();
  });

  it("returns duplicate only when the complete posted journal identity and lines match", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: "journal-existing", tenant_id: input.tenantId, idempotency_key: input.idempotencyKey,
        source_type: input.sourceType, source_reference: input.sourceReference,
        currency: input.currency, description: input.description,
        occurred_at: new Date(input.occurredAtUtc), status: "posted"
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [
        { account_id: "cash-account", currency: "SAR", line_number: 1, debit_minor: "10000", credit_minor: "0", memo: null },
        { account_id: "merchant-payable", currency: "SAR", line_number: 2, debit_minor: "0", credit_minor: "9000", memo: null },
        { account_id: "platform-revenue", currency: "SAR", line_number: 3, debit_minor: "0", credit_minor: "1000", memo: null }
      ], rowCount: 3 })
      .mockResolvedValueOnce({ rows: [], rowCount: null });
    const { service } = serviceWith(query);
    await expect(service.post(input)).resolves.toEqual({ outcome: "duplicate", journalId: "journal-existing" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("returns identity collision when an idempotency key is reused for different evidence", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: "journal-existing", tenant_id: input.tenantId, idempotency_key: input.idempotencyKey,
        source_type: input.sourceType, source_reference: "different-capture",
        currency: input.currency, description: input.description,
        occurred_at: new Date(input.occurredAtUtc), status: "posted"
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: null });
    const { service } = serviceWith(query);
    await expect(service.post(input)).resolves.toEqual({ outcome: "identity_collision" });
  });

  it("rolls back and releases the client when a database write fails", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [{ id: "journal-1" }], rowCount: 1 })
      .mockRejectedValueOnce(new Error("database write failed"))
      .mockResolvedValueOnce({ rows: [], rowCount: null });
    const { service, client } = serviceWith(query);
    await expect(service.post(input)).rejects.toThrow("database write failed");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns identity collision when the journal header matches but ledger allocations differ", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: "journal-existing", tenant_id: input.tenantId, idempotency_key: input.idempotencyKey,
        source_type: input.sourceType, source_reference: input.sourceReference,
        currency: input.currency, description: input.description,
        occurred_at: new Date(input.occurredAtUtc), status: "posted"
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [
        { account_id: "cash-account", currency: "SAR", line_number: 1, debit_minor: "10000", credit_minor: "0", memo: null },
        { account_id: "merchant-payable", currency: "SAR", line_number: 2, debit_minor: "0", credit_minor: "8500", memo: null },
        { account_id: "platform-revenue", currency: "SAR", line_number: 3, debit_minor: "0", credit_minor: "1500", memo: null }
      ], rowCount: 3 })
      .mockResolvedValueOnce({ rows: [], rowCount: null });
    const { service } = serviceWith(query);
    await expect(service.post(input)).resolves.toEqual({ outcome: "identity_collision" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

});
