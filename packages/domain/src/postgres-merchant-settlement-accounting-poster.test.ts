import { describe, expect, it, vi } from "vitest";
import { PostgresMerchantSettlementAccountingPoster } from "./postgres-merchant-settlement-accounting-poster.js";
import type { PostgresPool, PostgresClient, PostgresQueryResult } from "./postgres-iam-store.js";

function fakePool(handler: (sql: string, values: readonly unknown[]) => PostgresQueryResult<unknown> | Promise<PostgresQueryResult<unknown>>) {
  const calls: string[] = [];
  const client: PostgresClient = {
    release: vi.fn(),
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      calls.push(sql);
      return await handler(sql, values) as PostgresQueryResult<Row>;
    }
  };
  return {
    pool: { connect: async () => client } as unknown as PostgresPool,
    client,
    calls
  };
}

describe("PostgresMerchantSettlementAccountingPoster", () => {
  it("executes the atomic database function inside one transaction", async () => {
    const fake = fakePool(sql => {
      if (sql.includes("SELECT tenant_id FROM merchant_settlement_batches")) {
        return { rows: [{ tenant_id: "tenant-1" }], rowCount: 1 };
      }
      if (sql.includes("post_merchant_settlement_accounting")) {
        return { rows: [{ journal_id: "journal-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const result = await new PostgresMerchantSettlementAccountingPoster(fake.pool).post({
      batchId: "batch-1", actorId: "finance-1", actorRole: "finance"
    });
    expect(result).toEqual({ outcome: "posted", journalId: "journal-1" });
    expect(fake.calls[0]).toBe("BEGIN");
    expect(fake.calls.some(sql => sql.includes("FOR UPDATE"))).toBe(true);
    expect(fake.calls.some(sql => sql.includes("post_merchant_settlement_accounting"))).toBe(true);
    expect(fake.calls.at(-1)).toBe("COMMIT");
    expect(fake.client.release).toHaveBeenCalledOnce();
  });

  it("returns not found without calling the posting function", async () => {
    const fake = fakePool(() => ({ rows: [], rowCount: 0 }));
    const result = await new PostgresMerchantSettlementAccountingPoster(fake.pool).post({
      batchId: "missing-batch", actorId: "finance-1", actorRole: "finance"
    });
    expect(result).toEqual({ outcome: "not_found" });
    expect(fake.calls).toContain("ROLLBACK");
    expect(fake.calls.some(sql => sql.includes("post_merchant_settlement_accounting"))).toBe(false);
  });

  it("fails closed when the database reports missing accounting authorization", async () => {
    const fake = fakePool(sql => {
      if (sql.includes("SELECT tenant_id FROM merchant_settlement_batches")) {
        return { rows: [{ tenant_id: "tenant-1" }], rowCount: 1 };
      }
      if (sql.includes("post_merchant_settlement_accounting")) {
        throw new Error("settlement_accounting_authorization_required");
      }
      return { rows: [], rowCount: 1 };
    });
    const result = await new PostgresMerchantSettlementAccountingPoster(fake.pool).post({
      batchId: "batch-1", actorId: "finance-1", actorRole: "finance"
    });
    expect(result).toEqual({ outcome: "not_authorized" });
    expect(fake.calls).toContain("ROLLBACK");
  });
});
