import { describe, expect, it, vi } from "vitest";
import type { PostgresClient, PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresCustomerCheckoutService } from "./postgres-customer-checkout.js";

function poolWithTwoBranchCart() {
  const statements: string[] = [];
  const query = vi.fn(async <Row>(sql: string): Promise<PostgresQueryResult<Row>> => {
    statements.push(sql);
    let rows: unknown[] = [];
    if (sql.includes("FROM customer_carts") && sql.includes("FOR UPDATE")) {
      rows = [{ id: "cart-1", customer_id: "customer-1", currency: "SAR", version: 3 }];
    } else if (sql.includes("COUNT(*)::int AS item_count")) {
      rows = [{ item_count: 2 }];
    } else if (sql.includes("FROM customer_cart_items ci")) {
      rows = [
        { item_id: "line-1", merchant_id: "merchant-1", branch_id: "branch-1",
          merchant_tenant_id: "merchant-tenant-1", product_variant_id: "variant-1",
          quantity: 1, title: "Item 1", sku: "SKU-1", currency: "SAR", price_minor: "1000",
          merchant_active: true, branch_active: true, product_published: true, stock_eligible: true },
        { item_id: "line-2", merchant_id: "merchant-2", branch_id: "branch-2",
          merchant_tenant_id: "merchant-tenant-2", product_variant_id: "variant-2",
          quantity: 1, title: "Item 2", sku: "SKU-2", currency: "SAR", price_minor: "2000",
          merchant_active: true, branch_active: true, product_published: true, stock_eligible: true }
      ];
    }
    return { rows: rows as Row[], rowCount: rows.length };
  });
  const client = { query, release: vi.fn() } as unknown as PostgresClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as PostgresPool;
  return { pool, client, statements };
}

const input = {
  customerId: "customer-1", expectedCartVersion: 3, idempotencyKey: "checkout-key-0001",
  destination: { countryCode: "SA", cityCode: "JUBAIL", serviceCode: "standard_delivery",
    latitude: 27.01, longitude: 49.65 },
  actorId: "system-checkout", actorRole: "system" as const, correlationId: "request-1"
};

describe("PostgresCustomerCheckoutService", () => {
  it("rejects multi-branch carts and rolls back before quote or order creation", async () => {
    const db = poolWithTwoBranchCart();
    const service = new PostgresCustomerCheckoutService(db.pool, () => "generated-id");
    const result = await service.create(input);
    expect(result).toEqual({ outcome: "unsupported_multi_branch" });
    expect(db.statements[0]).toBe("BEGIN");
    expect(db.statements.at(-1)).toBe("ROLLBACK");
    expect(db.statements.some(sql => sql.includes("delivery_service_areas"))).toBe(false);
    expect(db.statements.some(sql => sql.includes("INSERT INTO customer_orders"))).toBe(false);
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it("rejects malformed checkout input before acquiring a connection", async () => {
    const db = poolWithTwoBranchCart();
    const service = new PostgresCustomerCheckoutService(db.pool, () => "generated-id");
    const result = await service.create({ ...input, destination: { ...input.destination, latitude: 91 } });
    expect(result).toEqual({ outcome: "invalid_delivery_request" });
    expect(db.pool.connect).not.toHaveBeenCalled();
  });
});
