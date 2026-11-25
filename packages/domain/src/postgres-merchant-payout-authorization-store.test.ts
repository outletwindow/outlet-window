import { describe, expect, it, vi } from "vitest";
import { PostgresMerchantPayoutAuthorizationStore } from "./postgres-merchant-payout-authorization-store.js";
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
  return { pool: { connect: async () => client } as unknown as PostgresPool, client, calls };
}

describe("PostgresMerchantPayoutAuthorizationStore", () => {
  it("creates a payout authorization request from a settlement batch in a transaction", async () => {
    const row = {
      id: "intent-1", tenant_id: "tenant-1", merchant_id: "merchant-1", currency: "SAR",
      settlement_batch_id: "batch-1", amount_minor: "12500", idempotency_key: "payout-key-1",
      status: "pending_approval", requested_by: "ops-1", requester_role: "operations",
      requested_at: "2026-11-25T08:00:00.000Z", reviewed_by: null, reviewer_role: null,
      reviewed_at: null, review_note: null
    };
    const fake = fakePool(sql => {
      if (sql.includes("SELECT tenant_id,merchant_id,currency FROM merchant_settlement_batches")) {
        return { rows: [{ tenant_id: "tenant-1", merchant_id: "merchant-1", currency: "SAR" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO merchant_payout_intents")) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const result = await new PostgresMerchantPayoutAuthorizationStore(fake.pool).request({
      settlementBatchId: "batch-1", amountMinor: 12500, idempotencyKey: "payout-key-1",
      requesterId: "ops-1", requesterRole: "operations"
    });
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(result.intent.amountMinor).toBe(12500);
      expect(result.intent.status).toBe("pending_approval");
    }
    expect(fake.calls[0]).toBe("BEGIN");
    expect(fake.calls.at(-1)).toBe("COMMIT");
    expect(fake.client.release).toHaveBeenCalledOnce();
  });

  it("rejects a self-approved payout and rolls back", async () => {
    const fake = fakePool(sql => {
      if (sql.includes("SELECT tenant_id FROM merchant_payout_intents")) {
        return { rows: [{ tenant_id: "tenant-1" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO merchant_payout_decisions")) {
        const error = new Error("merchant_payout_requester_cannot_approve_own_request") as Error & { code: string };
        error.code = "42501";
        throw error;
      }
      return { rows: [], rowCount: 1 };
    });
    const result = await new PostgresMerchantPayoutAuthorizationStore(fake.pool).decide({
      payoutIntentId: "intent-1", actorId: "ops-1", actorRole: "finance", decision: "authorize"
    });
    expect(result).toEqual({ outcome: "self_approval" });
    expect(fake.calls).toContain("ROLLBACK");
  });
});
