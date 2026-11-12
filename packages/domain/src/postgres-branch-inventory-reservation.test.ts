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
    expect(pool.client.released).toBe(true);
  });


  it("resolves catalog variant IDs to merchant external inventory IDs", async () => {
    class MappingClient implements PostgresClient {
      statements: string[] = [];
      insertedLineValues: readonly unknown[] | null = null;
      async query<Row>(sql: string, values: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
        const normalized = sql.trim().replace(/\\s+/g, " ");
        this.statements.push(normalized);
        if (sql.includes("FROM inventory_reservations WHERE idempotency_key")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM merchant_suborders s")) {
          return { rows: [{
            id: "suborder-1", order_id: "order-1", tenant_id: "tenant-1",
            merchant_id: "merchant-1", branch_id: "branch-1"
          } as Row], rowCount: 1 };
        }
        if (sql.includes("FROM customer_order_items oi") && sql.includes("ORDER BY oi.product_variant_id")) {
          return { rows: [{
            product_variant_id: "catalog-variant-1", sku: "SKU-1", quantity: 2
          } as Row], rowCount: 1 };
        }
        if (sql.includes("FROM customer_order_items oi") && sql.includes("commerce_catalog_variants")) {
          return { rows: [{
            product_variant_id: "external-variant-9", catalog_variant_id: "catalog-variant-1",
            sku: "SKU-1", available_quantity: 5, reserved_quantity: 0
          } as Row], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO inventory_reservation_lines")) {
          this.insertedLineValues = values;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
      release(): void {}
    }
    const client = new MappingClient();
    const pool: PostgresPool = {
      async query<Row>(): Promise<PostgresQueryResult<Row>> { return { rows: [], rowCount: 0 }; },
      async connect(): Promise<PostgresClient> { return client; }
    };
    const adapter = new PostgresBranchInventoryReservationAdapter(pool, () => "reservation-1");
    const result = await adapter.reserveExactVariants({
      tenantId: "tenant-1", orderId: "order-1", suborderId: "suborder-1",
      merchantId: "merchant-1", branchId: "branch-1",
      idempotencyKey: "checkout-key-0002", requestedAtUtc: "2026-11-09T10:00:00.000Z",
      lines: [{ productVariantId: "catalog-variant-1", sku: "SKU-1", quantity: 2 }]
    });
    expect(result).toEqual({ outcome: "reserved", reservationReference: "reservation-1" });
    expect(client.statements.some(sql => sql.includes("v.external_variant_id"))).toBe(true);
    expect(client.insertedLineValues).toEqual([
      "reservation-1", "merchant-1", "branch-1", "external-variant-9", "SKU-1", 2, "catalog-variant-1"
    ]);
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
