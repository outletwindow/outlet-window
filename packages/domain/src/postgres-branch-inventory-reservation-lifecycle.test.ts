import { describe, expect, it } from "vitest";
import type { PostgresClient, PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresBranchInventoryReservationLifecycle } from "./postgres-branch-inventory-reservation-lifecycle.js";

class FinalizeClient implements PostgresClient {
  statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  released = false;
  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    this.statements.push({ sql: sql.trim().replace(/\\s+/g, " "), values });
    if (sql.includes("FROM inventory_reservations") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: "reservation-1", status: "reserved", expires_at: null } as Row], rowCount: 1 };
    }
    if (sql.includes("FROM inventory_reservation_lines")) {
      return { rows: [{
        merchant_id: "merchant-1", branch_id: "branch-1",
        product_variant_id: "variant-1", quantity: 2
      } as Row], rowCount: 1 };
    }
    if (sql.includes("FROM branch_inventory i")) {
      return { rows: [{
        product_variant_id: "variant-1", available_quantity: 8, reserved_quantity: 2
      } as Row], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }
  release(): void { this.released = true; }
}

class FinalizePool implements PostgresPool {
  client = new FinalizeClient();
  async query<Row>(): Promise<PostgresQueryResult<Row>> { return { rows: [], rowCount: 0 }; }
  async connect(): Promise<PostgresClient> { return this.client; }
}

describe("branch-scoped PostgreSQL reservation finalization", () => {
  it("locks and updates only the reservation in the supplied tenant, merchant, and branch", async () => {
    const pool = new FinalizePool();
    const lifecycle = new PostgresBranchInventoryReservationLifecycle(pool);
    const result = await lifecycle.release({
      tenantId: "tenant-1",
      merchantId: "merchant-1",
      branchId: "branch-1",
      reservationId: "reservation-1",
      nowUtc: "2026-11-09T10:00:00.000Z",
      reason: "merchant_cancelled"
    });

    expect(result).toEqual({ outcome: "updated", status: "released" });
    const lock = pool.client.statements.find(s => s.sql.includes("FROM inventory_reservations") && s.sql.includes("FOR UPDATE"));
    expect(lock?.sql).toContain("tenant_id = $1 AND merchant_id = $2 AND branch_id = $3 AND id = $4");
    expect(lock?.values).toEqual(["tenant-1", "merchant-1", "branch-1", "reservation-1"]);

    const lineRead = pool.client.statements.find(s => s.sql.includes("FROM inventory_reservation_lines") && !s.sql.includes("JOIN inventory_reservation_lines"));
    expect(lineRead?.sql).toContain("reservation_id = $1 AND merchant_id = $2 AND branch_id = $3");
    expect(lineRead?.values).toEqual(["reservation-1", "merchant-1", "branch-1"]);

    const stockRead = pool.client.statements.find(s => s.sql.includes("FROM branch_inventory i"));
    expect(stockRead?.sql).toContain("l.reservation_id = $1 AND l.merchant_id = $2 AND l.branch_id = $3");
    expect(stockRead?.values).toEqual(["reservation-1", "merchant-1", "branch-1"]);

    const update = pool.client.statements.find(s => s.sql.startsWith("UPDATE inventory_reservations"));
    expect(update?.sql).toContain("SET status = $5, updated_at = $6");
    expect(update?.sql).toContain("tenant_id = $1 AND merchant_id = $2 AND branch_id = $3 AND id = $4");
    expect(update?.values).toEqual([
      "tenant-1", "merchant-1", "branch-1", "reservation-1",
      "released", "2026-11-09T10:00:00.000Z", "merchant_cancelled", null
    ]);
    expect(pool.client.released).toBe(true);
  });

  it("rolls back stock changes if the reservation status compare-and-swap updates no row", async () => {
    const pool = new FinalizePool();
    const originalQuery = pool.client.query.bind(pool.client);
    pool.client.query = async function<Row>(sql: string, values: readonly unknown[] = []) {
      if (sql.startsWith("UPDATE inventory_reservations")) {
        this.statements.push({ sql: sql.trim().replace(/\\s+/g, " "), values });
        return { rows: [], rowCount: 0 };
      }
      return originalQuery<Row>(sql, values);
    };
    const lifecycle = new PostgresBranchInventoryReservationLifecycle(pool);
    await expect(lifecycle.release({
      tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1",
      reservationId: "reservation-1", nowUtc: "2026-11-09T10:00:00.000Z",
      reason: "merchant_cancelled"
    })).rejects.toThrow("inventory_reservation_finalize_conflict");
    expect(pool.client.statements.some(s => s.sql === "ROLLBACK")).toBe(true);
    expect(pool.client.released).toBe(true);
  });

  it("does not touch a reservation when the supplied branch does not own it", async () => {
    const pool = new FinalizePool();
    pool.client.query = async function<Row>(sql: string, values: readonly unknown[] = []) {
      this.statements.push({ sql: sql.trim().replace(/\\s+/g, " "), values });
      if (sql.includes("FROM inventory_reservations") && sql.includes("FOR UPDATE")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    };
    const lifecycle = new PostgresBranchInventoryReservationLifecycle(pool);
    const result = await lifecycle.release({
      tenantId: "tenant-1",
      merchantId: "merchant-1",
      branchId: "branch-2",
      reservationId: "reservation-1",
      nowUtc: "2026-11-09T10:00:00.000Z",
      reason: "merchant_cancelled"
    });
    expect(result).toEqual({ outcome: "not_found" });
    expect(pool.client.statements.some(s => s.sql.startsWith("UPDATE branch_inventory"))).toBe(false);
    expect(pool.client.released).toBe(true);
  });
});
