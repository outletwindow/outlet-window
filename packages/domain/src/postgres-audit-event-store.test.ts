import { describe, expect, it, vi } from "vitest";
import { createAuditEvent } from "./audit.js";
import { PostgresAuditEventStore } from "./postgres-audit-event-store.js";
import type { PostgresQueryable, PostgresQueryResult } from "./postgres-iam-store.js";

function fakeDatabase(rows: Record<string, unknown>[] = [], rowCount: number | null = 1) {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) =>
    ({ rows, rowCount }) as PostgresQueryResult<Record<string, unknown>>);
  return { query, database: { query } as unknown as PostgresQueryable };
}

const event = createAuditEvent({
  id: "evt-1", type: "branch.updated", category: "merchant",
  occurredAt: "2026-11-07T10:00:00.000Z",
  actor: { id: "user-1", type: "merchant_user", role: "merchant_admin" },
  action: "branch.update", outcome: "success", tenantId: "tenant-a",
  merchantId: "merchant-a", branchId: "branch-a", correlationId: "corr-1",
  source: "api", severity: "info", metadata: { branch: "branch-a", accessToken: "never-store-me" }
});

describe("PostgresAuditEventStore", () => {
  it("persists sanitized events and returns duplicate status idempotently", async () => {
    const first = fakeDatabase([], 1);
    const store = new PostgresAuditEventStore(first.database);
    expect(await store.append(event)).toBe("inserted");
    const values = first.query.mock.calls[0]?.[1] ?? [];
    expect(values[20]).toContain("[REDACTED]");

    const duplicate = fakeDatabase([], 0);
    expect(await new PostgresAuditEventStore(duplicate.database).append(event)).toBe("already_exists");
  });

  it("reads only the requested tenant with a bounded page size", async () => {
    const db = fakeDatabase([{
      id: "evt-tenant-a", event_type: "branch.updated", category: "merchant",
      occurred_at: "2026-11-07T10:00:00.000Z", actor_id: "user-a",
      actor_type: "merchant_user", actor_role: "merchant_admin", action: "branch.update",
      outcome: "success", resource_type: "branch", resource_id: "branch-a",
      tenant_id: "tenant-a", merchant_id: "merchant-a", branch_id: "branch-a",
      correlation_id: "corr-a", request_id: null, source: "api", severity: "info",
      approval_id: null, metadata: { safe: true }
    }]);
    const result = await new PostgresAuditEventStore(db.database).list({ tenantId: "tenant-a", limit: 50 });
    expect(result).toHaveLength(1);
    expect(result[0]?.tenantId).toBe("tenant-a");
    expect(db.query.mock.calls[0]?.[1]).toEqual(["tenant-a", null, 50]);
    expect(db.query.mock.calls[0]?.[0]).toContain("WHERE tenant_id = $1");
  });

  it("rejects invalid page limits before querying", async () => {
    const db = fakeDatabase();
    const store = new PostgresAuditEventStore(db.database);
    await expect(store.list({ tenantId: "tenant-a", limit: 201 })).rejects.toThrow(RangeError);
    expect(db.query).not.toHaveBeenCalled();
  });
});
