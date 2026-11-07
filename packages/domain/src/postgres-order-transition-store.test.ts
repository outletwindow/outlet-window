import { describe, expect, it, vi } from "vitest";
import { PostgresOrderTransitionStore } from "./postgres-order-transition-store.js";
import type { PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";

function fakePool(options: { version?: number; missing?: boolean; statuses?: string[] } = {}) {
  const statements: string[] = [];
  const query = vi.fn(async <Row>(sql: string, _values?: readonly unknown[]) => {
    statements.push(sql);
    let rows: unknown[] = [];
    let rowCount: number | null = 1;
    if (sql.includes("FROM merchant_suborders s") && sql.includes("FOR UPDATE")) {
      rows = options.missing ? [] : [{
        id: "sub-1", order_id: "order-1", tenant_id: "tenant-1",
        status: "pending_validation", version: options.version ?? 1,
        merchant_id: "merchant-1", branch_id: "branch-1"
      }];
      rowCount = rows.length;
    } else if (sql.includes("SELECT status FROM merchant_suborders")) {
      rows = (options.statuses ?? ["awaiting_payment"]).map(status => ({ status }));
      rowCount = rows.length;
    }
    return { rows: rows as Row[], rowCount } as PostgresQueryResult<Row>;
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as PostgresPool;
  return { pool, query, statements, client };
}

const context = {
  actorId: "customer-1", actorRole: "customer",
  occurredAt: "2026-11-07T12:00:00.000Z", expectedVersion: 1
};

describe("PostgresOrderTransitionStore", () => {
  it("updates the suborder and recomputes the parent in one transaction", async () => {
    const db = fakePool();
    const result = await new PostgresOrderTransitionStore(db.pool).transitionSuborder({
      tenantId: "tenant-1", orderId: "order-1", suborderId: "sub-1",
      nextStatus: "awaiting_payment", context
    });
    expect(result).toMatchObject({
      outcome: "updated", parentStatus: "awaiting_payment",
      transition: { ok: true, previousStatus: "pending_validation" }
    });
    expect(db.statements[0]).toBe("BEGIN");
    expect(db.statements.at(-1)).toBe("COMMIT");
    expect(db.statements.some(sql => sql.includes("WHERE tenant_id = $1 AND order_id = $2 AND id = $3 AND version = $6"))).toBe(true);
    expect(db.statements.some(sql => sql.includes("SET status = $3, version = version + 1"))).toBe(true);
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it("rejects stale versions without writing", async () => {
    const db = fakePool({ version: 2 });
    const result = await new PostgresOrderTransitionStore(db.pool).transitionSuborder({
      tenantId: "tenant-1", orderId: "order-1", suborderId: "sub-1",
      nextStatus: "awaiting_payment", context
    });
    expect(result).toEqual({ outcome: "conflict" });
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements.some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });

  it("does not expose records outside the tenant-scoped lookup", async () => {
    const db = fakePool({ missing: true });
    const result = await new PostgresOrderTransitionStore(db.pool).transitionSuborder({
      tenantId: "tenant-other", orderId: "order-1", suborderId: "sub-1",
      nextStatus: "awaiting_payment", context
    });
    expect(result).toEqual({ outcome: "not_found" });
    expect(db.query.mock.calls[1]?.[1]).toEqual(["tenant-other", "order-1", "sub-1"]);
  });

  it("rejects invalid lifecycle transitions and rolls back", async () => {
    const db = fakePool();
    const result = await new PostgresOrderTransitionStore(db.pool).transitionSuborder({
      tenantId: "tenant-1", orderId: "order-1", suborderId: "sub-1",
      nextStatus: "delivered", context
    });
    expect(result).toEqual({ outcome: "rejected", reason: "invalid_transition" });
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements.some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });
});
