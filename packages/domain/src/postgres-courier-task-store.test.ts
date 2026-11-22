import { describe, expect, it, vi } from "vitest";
import type { PostgresPool } from "./postgres-iam-store.js";
import { PostgresCourierTaskStore } from "./postgres-courier-task-store.js";

describe("PostgresCourierTaskStore pickup-code attempt persistence", () => {
  it("commits a failed attempt so the database attempt limit cannot be bypassed by rollback", async () => {
    const statements: string[] = [];
    const taskRow = {
      id: "task-1",
      tenant_id: "tenant-1",
      order_id: "order-1",
      suborder_id: "suborder-1",
      courier_id: "courier-1",
      status: "arrived_at_pickup",
      version: 3,
      updated_at: "2026-11-22T05:00:00.000Z"
    };
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("SELECT t.id")) return { rows: [taskRow], rowCount: 1 };
      if (sql.includes("SET consumed_at")) return { rows: [], rowCount: 0 };
      if (sql.includes("SET failed_attempts")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() };
    const pool = {
      connect: vi.fn().mockResolvedValue(client)
    } as unknown as PostgresPool;
    const store = new PostgresCourierTaskStore(
      pool,
      async () => "a".repeat(64),
      () => new Date("2026-11-22T05:01:00.000Z")
    );

    const result = await store.transition({
      tenantId: "tenant-1",
      taskId: "task-1",
      courierId: "courier-1",
      nextStatus: "picked_up",
      expectedVersion: 3,
      pickupCode: "incorrect-code"
    });

    expect(result).toEqual({
      outcome: "rejected",
      reason: "pickup_code_not_verified"
    });
    expect(statements.some(sql => sql.includes("SET failed_attempts"))).toBe(true);
    expect(statements).toContain("COMMIT");
    expect(statements).not.toContain("ROLLBACK");
    expect(statements.some(sql => sql.includes("UPDATE courier_delivery_tasks"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
