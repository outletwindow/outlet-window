import { describe, expect, it, vi } from "vitest";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";
import { PostgresVerifiedCaptureFinancialJournalProjector } from "./postgres-verified-capture-financial-journal-projector.js";

const capture = {
  id: "capture-1", tenant_id: "tenant-1", amount_minor: "12500", currency: "SAR",
  captured_at: new Date("2026-11-15T05:00:00.000Z"), provider_key: "moyasar", provider_event_id: "evt-1"
};
const accounts = [
  { id: "clearing-1", account_code: "PAYMENT_CLEARING", account_type: "asset" as const, currency: "SAR" },
  { id: "held-1", account_code: "CUSTOMER_FUNDS_HELD", account_type: "liability" as const, currency: "SAR" }
];

function setup(poolQuery: ReturnType<typeof vi.fn>, clientQuery: ReturnType<typeof vi.fn>) {
  const client = { query: clientQuery, release: vi.fn() } as unknown as PostgresClient;
  const pool = {
    query: poolQuery,
    connect: vi.fn().mockResolvedValue(client)
  } as unknown as PostgresPool;
  return { projector: new PostgresVerifiedCaptureFinancialJournalProjector(pool, { createId: () => "journal-1" }), client };
}

describe("PostgresVerifiedCaptureFinancialJournalProjector", () => {
  it("posts the exact captured amount to clearing and customer-funds liability accounts", async () => {
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [capture], rowCount: 1 })
      .mockResolvedValueOnce({ rows: accounts, rowCount: 2 });
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "journal-1" }], rowCount: 1 }) // journal
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "journal-1" }], rowCount: 1 }) // post
      .mockResolvedValueOnce({ rows: [], rowCount: null }); // COMMIT
    const { projector, client } = setup(poolQuery, clientQuery);

    await expect(projector.project("capture-1")).resolves.toEqual({
      outcome: "posted", journalId: "journal-1", captureId: "capture-1"
    });
    expect(poolQuery.mock.calls[1]?.[0]).toContain("tenant_id=$1 AND currency=$2");
    expect(poolQuery.mock.calls[1]?.[1]).toEqual(["tenant-1", "SAR", ["PAYMENT_CLEARING", "CUSTOMER_FUNDS_HELD"]]);
    expect(clientQuery.mock.calls[2]?.[1]).toEqual([
      expect.any(String), "tenant-1", "journal-1", "clearing-1", "SAR", 1, 12500, 0,
      "Payment provider clearing receivable"
    ]);
    expect(clientQuery.mock.calls[3]?.[1]).toEqual([
      expect.any(String), "tenant-1", "journal-1", "held-1", "SAR", 2, 0, 12500,
      "Customer funds held pending order fulfilment"
    ]);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("fails closed when tenant-specific ledger accounts are not configured", async () => {
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [capture], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [accounts[0]], rowCount: 1 });
    const clientQuery = vi.fn();
    const { projector } = setup(poolQuery, clientQuery);
    await expect(projector.project("capture-1")).resolves.toEqual({
      outcome: "accounts_not_configured", captureId: "capture-1"
    });
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("does not accept accounts with incorrect accounting classifications", async () => {
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [capture], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [
        accounts[0], { ...accounts[1], account_type: "revenue" as const }
      ], rowCount: 2 });
    const { projector } = setup(poolQuery, vi.fn());
    await expect(projector.project("capture-1"))
      .rejects.toThrow("INVALID_CAPTURE_FINANCIAL_ACCOUNT_CONFIGURATION");
  });

  it("returns capture_not_found without attempting account lookup", async () => {
    const poolQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const { projector } = setup(poolQuery, vi.fn());
    await expect(projector.project("missing")).resolves.toEqual({ outcome: "capture_not_found" });
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe captured amounts", async () => {
    const poolQuery = vi.fn().mockResolvedValueOnce({
      rows: [{ ...capture, amount_minor: "9007199254740992" }], rowCount: 1
    });
    const { projector } = setup(poolQuery, vi.fn());
    await expect(projector.project("capture-1"))
      .rejects.toThrow("INVALID_VERIFIED_CAPTURE_FINANCIAL_EVIDENCE");
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it("scans a bounded batch of unprojected verified captures and projects them idempotently", async () => {
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "capture-1" }, { id: "capture-2" }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [capture], rowCount: 1 })
      .mockResolvedValueOnce({ rows: accounts, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [capture], rowCount: 1 })
      .mockResolvedValueOnce({ rows: accounts, rowCount: 2 });
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [{ id: "journal-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "journal-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [{ id: "journal-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "journal-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: null });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PostgresClient;
    const pool = { query: poolQuery, connect: vi.fn().mockResolvedValue(client) } as unknown as PostgresPool;
    const projector = new PostgresVerifiedCaptureFinancialJournalProjector(pool, { createId: () => "journal-1" });
    // Each capture uses a fresh client in production; mock the two transaction sequences explicitly.
    const secondClient = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [{ id: "journal-2" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "journal-2" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: null }), release: vi.fn() } as unknown as PostgresClient;
    (pool.connect as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(client).mockResolvedValueOnce(secondClient);
    await expect(projector.projectPending(2)).resolves.toHaveLength(2);
    expect(poolQuery.mock.calls[0]?.[0]).toContain("NOT EXISTS");
    expect(poolQuery.mock.calls[0]?.[1]).toEqual([2]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(secondClient.release).toHaveBeenCalledOnce();
  });

  it("rejects an invalid capture identifier before database access", async () => {
    const poolQuery = vi.fn();
    const { projector } = setup(poolQuery, vi.fn());
    await expect(projector.project("")).rejects.toThrow("INVALID_VERIFIED_CAPTURE_ID");
    expect(poolQuery).not.toHaveBeenCalled();
  });
});
