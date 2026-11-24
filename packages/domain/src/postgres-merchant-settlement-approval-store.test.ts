import { describe, expect, it, vi } from "vitest";
import { PostgresMerchantSettlementApprovalStore } from "./postgres-merchant-settlement-approval-store.js";
import type { PostgresPool, PostgresClient, PostgresQueryResult } from "./postgres-iam-store.js";

const approvalRow = {
  id: "approval-1", tenant_id: "tenant-1", batch_id: "batch-1", merchant_id: "merchant-1",
  currency: "SAR", requested_by: "operations-1", requester_role: "operations",
  status: "pending", snapshot_line_count: "1", snapshot_gross_minor: "12000",
  snapshot_deductions_minor: "1000", snapshot_net_minor: "11000",
  requested_at: "2026-11-24T12:00:00.000Z", reviewed_by: null, reviewer_role: null,
  reviewed_at: null, review_note: null
};

function poolWith(handler: (sql: string, values: readonly unknown[]) => PostgresQueryResult<unknown> | Promise<PostgresQueryResult<unknown>>) {
  const statements: string[] = [];
  const client: PostgresClient = {
    release: vi.fn(),
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      statements.push(sql);
      const result = await handler(sql, values);
      return result as PostgresQueryResult<Row>;
    }
  };
  const pool = { connect: async () => client, query: client.query.bind(client) } as unknown as PostgresPool;
  return { pool, statements, client };
}

describe("PostgresMerchantSettlementApprovalStore", () => {
  it("captures request in one transaction while locking the batch", async () => {
    const fake = poolWith(sql => {
      if (sql.includes("SELECT status FROM merchant_settlement_batches")) return { rows: [{ status: "draft" }], rowCount: 1 };
      if (sql.includes("INSERT INTO merchant_settlement_approval_requests")) return { rows: [approvalRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const store = new PostgresMerchantSettlementApprovalStore(fake.pool);
    const result = await store.request({ batchId: "batch-1", requesterId: "operations-1", requesterRole: "operations" });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("expected request creation");
    expect(result.request.snapshotNetMinor).toBe(11000);
    expect(fake.statements[0]).toBe("BEGIN");
    expect(fake.statements.some(sql => sql.includes("FOR UPDATE"))).toBe(true);
    expect(fake.statements.at(-1)).toBe("COMMIT");
    expect(fake.client.release).toHaveBeenCalledOnce();
  });

  it("keeps decision insertion and request state transition inside one transaction", async () => {
    const decided = { ...approvalRow, status: "authorized_for_accounting",
      reviewed_by: "finance-1", reviewer_role: "finance", reviewed_at: "2026-11-24T12:05:00.000Z",
      review_note: "checked" };
    const fake = poolWith(sql => {
      if (sql.includes("SELECT tenant_id FROM merchant_settlement_approval_requests")) return { rows: [{ tenant_id: "tenant-1" }], rowCount: 1 };
      if (sql.includes("SELECT id,tenant_id,batch_id,merchant_id,currency")) return { rows: [decided], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const store = new PostgresMerchantSettlementApprovalStore(fake.pool);
    const result = await store.decide({
      requestId: "approval-1", actorId: "finance-1", actorRole: "finance",
      decision: "authorize_accounting", reason: "checked"
    });
    expect(result.outcome).toBe("decided");
    expect(fake.statements[0]).toBe("BEGIN");
    expect(fake.statements.some(sql => sql.includes("INSERT INTO merchant_settlement_approval_decisions"))).toBe(true);
    expect(fake.statements.at(-1)).toBe("COMMIT");
  });


  it("lists only pending review requests with a bounded limit", async () => {
    const fake = poolWith(sql => sql.includes("WHERE status='pending'")
      ? { rows: [approvalRow], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const result = await new PostgresMerchantSettlementApprovalStore(fake.pool).listPending({ limit: 25 });
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("pending");
    expect(fake.statements[0]).toContain("WHERE status='pending'");
    await expect(new PostgresMerchantSettlementApprovalStore(fake.pool).listPending({ limit: 101 }))
      .rejects.toThrow("settlement_approval_limit_invalid");
  });

  it("maps database self-approval rejection without leaking a database error", async () => {
    const fake = poolWith(sql => {
      if (sql.includes("SELECT tenant_id FROM merchant_settlement_approval_requests")) return { rows: [{ tenant_id: "tenant-1" }], rowCount: 1 };
      if (sql.includes("INSERT INTO merchant_settlement_approval_decisions")) throw Object.assign(new Error("self approval"), { code: "42501" });
      return { rows: [], rowCount: 0 };
    });
    const result = await new PostgresMerchantSettlementApprovalStore(fake.pool).decide({
      requestId: "approval-1", actorId: "operations-1", actorRole: "finance",
      decision: "authorize_accounting"
    });
    expect(result).toEqual({ outcome: "self_approval" });
    expect(fake.statements).toContain("ROLLBACK");
  });
});
