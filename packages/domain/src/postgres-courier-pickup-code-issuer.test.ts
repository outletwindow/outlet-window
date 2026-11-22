import { describe, expect, it, vi } from "vitest";
import type { PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresCourierPickupCodeIssuer } from "./postgres-courier-pickup-code-issuer.js";

function fakePool(options: { task?: boolean; existingCredential?: boolean; failAudit?: boolean } = {}) {
  const statements: string[] = [];
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const query = vi.fn(async <Row>(sql: string, values?: readonly unknown[]) => {
    statements.push(sql);
    calls.push({ sql, ...(values === undefined ? {} : { values }) });
    if (sql.includes("SELECT t.id AS task_id")) {
      const rows = options.task === false ? [] : [{
        task_id: "task-1", task_status: "arrived_at_pickup", suborder_status: "ready_for_pickup"
      }];
      return { rows: rows as Row[], rowCount: rows.length } as PostgresQueryResult<Row>;
    }
    if (sql.includes("UPDATE courier_pickup_code_credentials")) {
      const rows = options.existingCredential ? [{ id: "old-credential" }] : [];
      return { rows: rows as Row[], rowCount: rows.length } as PostgresQueryResult<Row>;
    }
    if (sql.includes("INSERT INTO courier_pickup_code_issuance_audit") && options.failAudit) {
      throw new Error("audit_write_failed");
    }
    return { rows: [], rowCount: 1 } as PostgresQueryResult<Row>;
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), query } as unknown as PostgresPool;
  return { pool, query, statements, calls, client };
}

const input = {
  tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1",
  orderId: "order-1", suborderId: "suborder-1", taskId: "task-1",
  actorId: "employee-1", actorRole: "merchant_employee" as const
};

describe("PostgresCourierPickupCodeIssuer", () => {
  it("issues a short-lived code while persisting only its digest and an immutable audit row", async () => {
    const db = fakePool();
    const digestCode = vi.fn(async () => "a".repeat(64));
    const issuer = new PostgresCourierPickupCodeIssuer(
      db.pool, digestCode, () => new Date("2026-11-22T05:00:00.000Z")
    );
    const result = await issuer.issue(input);

    expect(result.outcome).toBe("issued");
    if (result.outcome !== "issued") throw new Error("expected issued outcome");
    expect(result.code).toMatch(/^\d{8}$/);
    expect(result.expiresAtUtc).toBe("2026-11-22T05:15:00.000Z");
    expect(digestCode).toHaveBeenCalledWith(result.code);
    const credentialInsert = db.calls.find(call => call.sql.includes("INSERT INTO courier_pickup_code_credentials"));
    expect(credentialInsert?.values).toContain("a".repeat(64));
    expect(credentialInsert?.values).not.toContain(result.code);
    expect(db.statements.some(sql => sql.includes("INSERT INTO courier_pickup_code_issuance_audit"))).toBe(true);
    expect(db.statements.at(-1)).toBe("COMMIT");
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it("locks and scopes the task through tenant, merchant, branch, order and suborder", async () => {
    const db = fakePool();
    await new PostgresCourierPickupCodeIssuer(db.pool, async () => "b".repeat(64)).issue(input);
    const lock = db.calls.find(call => call.sql.includes("SELECT t.id AS task_id"));
    expect(lock?.sql).toContain("t.tenant_id = $1 AND t.id = $2 AND t.suborder_id = $3");
    expect(lock?.sql).toContain("s.order_id = $4 AND s.merchant_id = $5 AND s.branch_id = $6");
    expect(lock?.sql).toContain("FOR UPDATE OF t, s");
    expect(lock?.values).toEqual([
      "tenant-1", "task-1", "suborder-1", "order-1", "merchant-1", "branch-1"
    ]);
  });

  it("revokes an existing live credential before issuing a replacement", async () => {
    const db = fakePool({ existingCredential: true });
    const result = await new PostgresCourierPickupCodeIssuer(db.pool, async () => "c".repeat(64)).issue(input);
    expect(result.outcome).toBe("issued");
    const audit = db.calls.find(call => call.sql.includes("INSERT INTO courier_pickup_code_issuance_audit"));
    expect(audit?.values).toContain("reissued");
  });

  it("does not issue a code for a task outside the supplied merchant scope", async () => {
    const db = fakePool({ task: false });
    const result = await new PostgresCourierPickupCodeIssuer(db.pool, async () => "d".repeat(64)).issue(input);
    expect(result).toEqual({ outcome: "not_found" });
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements.some(sql => sql.includes("INSERT INTO courier_pickup_code_credentials"))).toBe(false);
  });

  it("rolls back credential creation if the immutable audit insert fails", async () => {
    const db = fakePool({ failAudit: true });
    await expect(new PostgresCourierPickupCodeIssuer(db.pool, async () => "e".repeat(64)).issue(input))
      .rejects.toThrow("audit_write_failed");
    expect(db.statements).toContain("ROLLBACK");
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it("rejects non-merchant actors before opening a database transaction", async () => {
    const db = fakePool();
    const result = await new PostgresCourierPickupCodeIssuer(db.pool, async () => "f".repeat(64)).issue({
      ...input, actorRole: "courier" as never
    });
    expect(result).toEqual({ outcome: "invalid_actor" });
    expect(db.pool.connect).not.toHaveBeenCalled();
  });
});
