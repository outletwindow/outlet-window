import { describe, expect, it } from "vitest";
import type { PostgresClient, PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresBranchInventoryReservationAdapter } from "./postgres-branch-inventory-reservation.js";

class ReplayClient implements PostgresClient {
  statements: string[] = [];
  released = false;
  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    this.statements.push(sql.trim().replace(/\\s+/g, " "));
    if (sql.includes("FROM inventory_reservations WHERE idempotency_key")) {
      return { rows: [{
        id: "reservation-1", tenant_id: "tenant-1", order_id: "order-1",
        suborder_id: "suborder-1", merchant_id: "merchant-1",
        branch_id: "branch-1", status: "reserved"
      } as Row], rowCount: 1 };
    }
    if (sql.includes("FROM inventory_reservation_lines")) {
      return { rows: [{
        product_variant_id: "variant-1", sku: "SKU-1", quantity: 1
      } as Row], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }
  release(): void { this.released = true; }
}
class ReplayPool implements PostgresPool {
  client = new ReplayClient();
  async query<Row>(): Promise<PostgresQueryResult<Row>> { return { rows: [], rowCount: 0 }; }
  async connect(): Promise<PostgresClient> { return this.client; }
}

describe("PostgreSQL branch inventory reservation idempotency", () => {
  it("serializes retries before reading and returns the original reservation", async () => {
    const pool = new ReplayPool();
    const adapter = new PostgresBranchInventoryReservationAdapter(pool);
    const result = await adapter.reserveExactVariants({
      tenantId: "tenant-1", orderId: "order-1", suborderId: "suborder-1",
      merchantId: "merchant-1", branchId: "branch-1",
      idempotencyKey: "checkout-key-0001", requestedAtUtc: "2026-11-09T10:00:00.000Z",
      lines: [{ productVariantId: "variant-1", sku: "SKU-1", quantity: 1 }]
    });
    expect(result).toEqual({ outcome: "reserved", reservationReference: "reservation-1" });
    const lockIndex = pool.client.statements.findIndex(sql => sql.includes("pg_advisory_xact_lock"));
    const lookupIndex = pool.client.statements.findIndex(sql => sql.includes("FROM inventory_reservations WHERE idempotency_key"));
    expect(lockIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeLessThan(lookupIndex);
    expect(pool.client.statements).toContain("COMMIT");
    const stockEligibilityQuery = pool.client.statements.find(sql => sql.includes("FROM branch_inventory i"));
    expect(stockEligibilityQuery).toContain("FOR UPDATE OF m, b, i");
    expect(pool.client.released).toBe(true);
  });

  it("rejects reuse of an idempotency key for different order lines", async () => {
    const pool = new ReplayPool();
    const adapter = new PostgresBranchInventoryReservationAdapter(pool);
    await expect(adapter.reserveExactVariants({
      tenantId: "tenant-1", orderId: "order-1", suborderId: "suborder-1",
      merchantId: "merchant-1", branchId: "branch-1",
      idempotencyKey: "checkout-key-0001", requestedAtUtc: "2026-11-09T10:00:00.000Z",
      lines: [{ productVariantId: "variant-1", sku: "SKU-1", quantity: 2 }]
    })).rejects.toThrow("inventory_reservation_idempotency_conflict");
    expect(pool.client.released).toBe(true);
  });
});
