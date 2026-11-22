import { describe, expect, it, vi } from "vitest";
import type { PostgresClient, PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresOrderStore, type CreateCustomerOrderInput } from "./postgres-order-store.js";

const order: CreateCustomerOrderInput = {
  id: "order-1", tenantId: "tenant-1", customerId: "customer-1",
  idempotencyKey: "checkout-key-0001", currency: "SAR", totalMinor: 12900,
  metadata: { source: "web" },
  suborders: [{
    id: "suborder-1", merchantId: "merchant-1", branchId: "branch-1",
    status: "pending_validation", subtotalMinor: 12900, metadata: { channel: "store" },
    items: [{
      id: "item-1", productVariantId: "variant-1", sku: "SKU-1",
      sizeLabel: "M", colorLabel: "Black", quantity: 2, unitPriceMinor: 6450, currency: "SAR"
    }]
  }]
};

function database(options: { existing?: boolean; existingTotal?: string; existingSuborderStatus?: string;
  unavailableBranch?: boolean; unavailableVariant?: boolean; catalogPrice?: string; catalogCurrency?: string; inventoryEligible?: boolean } = {}) {
  const statements: string[] = [];
  const query = vi.fn(async <Row>(sql: string, _args?: readonly unknown[]) => {
    statements.push(sql);
    let rows: unknown[] = [];
    let rowCount: number | null = 1;
    if (sql.includes("FROM customer_orders") && sql.includes("FOR UPDATE")) {
      rows = options.existing ? [{ id: "persisted-order", currency: "SAR",
        total_minor: options.existingTotal ?? "12900", metadata: { source: "web" } }] : [];
      rowCount = rows.length;
    } else if (sql.includes("FROM merchant_suborders") && sql.includes("ORDER BY id")) {
      rows = [{ id: "suborder-1", merchant_id: "merchant-1", branch_id: "branch-1",
        status: options.existingSuborderStatus ?? "pending_validation", subtotal_minor: "12900", metadata: { channel: "store" } }];
      rowCount = 1;
    } else if (sql.includes("FROM customer_order_items WHERE order_id")) {
      rows = [{
        id: "item-1", suborder_id: "suborder-1", product_variant_id: "variant-1",
        sku: "SKU-1", size_label: "M", color_label: "Black", quantity: 2,
        unit_price_minor: "6450", currency: "SAR"
      }];
      rowCount = 1;
    } else if (sql.includes("INSERT INTO merchant_suborders")) {
      rows = options.unavailableBranch ? [] : [{ id: "suborder-1", tenant_id: "merchant-tenant-1" }];
      rowCount = rows.length;
    } else if (sql.includes("INSERT INTO customer_orders")) {
      rows = [];
      rowCount = 1;
    } else if (sql.includes("FROM commerce_catalog_variants v") && sql.includes("FOR SHARE OF v, p")) {
      rows = options.unavailableVariant ? [] : [{
        id: "variant-1", external_variant_id: "external-variant-1",
        catalog_price_minor: options.catalogPrice ?? "6450",
        catalog_currency: options.catalogCurrency ?? "SAR"
      }];
      rowCount = rows.length;
    } else if (sql.includes("FROM branch_inventory i") && sql.includes("FOR UPDATE")) {
      rows = [{ stock_eligible: options.inventoryEligible ?? true }];
      rowCount = 1;
    } else if (sql.includes("INSERT INTO customer_order_items")) {
      rows = [];
      rowCount = 1;
    }
    return { rows: rows as Row[], rowCount } as PostgresQueryResult<Row>;
  });
  const client = { query, release: vi.fn() } as unknown as PostgresClient;
  const pool = { query, connect: vi.fn(async () => client) } as unknown as PostgresPool;
  return { pool, statements, client };
}

describe("PostgresOrderStore", () => {
  it("creates the parent, merchant suborder, and exact order lines atomically", async () => {
    const db = database();
    const result = await new PostgresOrderStore(db.pool).create(order);
    expect(result).toEqual({ outcome: "created", orderId: "order-1" });
    expect(db.statements[0]).toBe("BEGIN");
    expect(db.statements.some(sql => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(db.statements.some(sql => sql.includes("INSERT INTO customer_orders"))).toBe(true);
    expect(db.statements.some(sql => sql.includes("m.status = 'active' AND b.status = 'active'"))).toBe(true);
    expect(db.statements.some(sql => sql.includes("INSERT INTO customer_order_items"))).toBe(true);
    expect(db.statements.at(-1)).toBe("COMMIT");
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it("persists the delivery snapshot fields required by platform readiness", async () => {
    const db = database();
    const input: CreateCustomerOrderInput = {
      ...order,
      deliveryDestination: { latitude: 27.01, longitude: 49.65, countryCode: "SA", cityCode: "JUBAIL" },
      deliveryQuote: { quoteId: "quote-1", ruleId: "rule-1", ruleVersion: 1, currency: "SAR",
        totalMinor: 1500, createdAtUtc: "2026-11-14T16:00:00.000Z",
        expiresAtUtc: "2026-11-14T16:05:00.000Z" },
      deliveryZoneId: "zone-1",
      deliveryBranchId: "branch-1"
    };
    await new PostgresOrderStore(db.pool).create(input);
    const insert = db.statements.find(sql => sql.includes("INSERT INTO customer_orders")) ?? "";
    expect(insert).toContain("delivery_destination");
    expect(insert).toContain("delivery_quote");
    expect(insert).toContain("delivery_zone_id");
    expect(insert).toContain("delivery_branch_id");
  });

  it("rejects incomplete delivery snapshots before opening a transaction", async () => {
    const db = database();
    await expect(new PostgresOrderStore(db.pool).create({
      ...order, deliveryDestination: { latitude: 27.01, longitude: 49.65 }
    })).rejects.toThrow("Delivery destination, quote, zone, and branch must be supplied together");
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  it("supports order creation inside a caller-owned transaction without controlling its lifecycle", async () => {
    const db = database();
    const client = await db.pool.connect();
    const result = await new PostgresOrderStore(db.pool).createInTransaction(order, client);
    expect(result).toEqual({ outcome: "created", orderId: "order-1" });
    expect(db.statements).not.toContain("BEGIN");
    expect(db.statements).not.toContain("COMMIT");
    expect(db.statements).not.toContain("ROLLBACK");
    expect(client.release).not.toHaveBeenCalled();
    expect(db.statements.filter(sql => sql.includes("pg_advisory_xact_lock"))).toHaveLength(1);
  });

  it("rolls back when a merchant branch is unavailable", async () => {
    const db = database({ unavailableBranch: true });
    await expect(new PostgresOrderStore(db.pool).create(order))
      .rejects.toThrow("Merchant branch is unavailable for order creation");
    expect(db.statements.at(-1)).toBe("ROLLBACK");
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it("rejects a variant that is unpublished, belongs to another merchant, or has mismatched SKU/currency", async () => {
    const db = database({ unavailableVariant: true });
    await expect(new PostgresOrderStore(db.pool).create(order))
      .rejects.toThrow("Order item variant is not published for this merchant or its SKU/currency does not match");
    const validation = db.statements.find(sql => sql.includes("FROM commerce_catalog_variants v")) ?? "";
    expect(validation).toContain("v.tenant_id = $1 AND v.id = $2 AND v.sku = $3");
    expect(validation).toContain("p.published_at IS NOT NULL");
    expect(db.statements.at(-1)).toBe("ROLLBACK");
    expect(db.statements.some(sql => sql.includes("INSERT INTO customer_order_items"))).toBe(false);
  });


  it("rejects a caller-supplied unit price that differs from the locked live catalog price", async () => {
    const db = database({ catalogPrice: "1" });
    await expect(new PostgresOrderStore(db.pool).create(order))
      .rejects.toThrow("Order item price does not match the current published catalog price");
    expect(db.statements.some(sql => sql.includes("INSERT INTO customer_order_items"))).toBe(false);
    expect(db.statements.at(-1)).toBe("ROLLBACK");
  });

  it("locks and validates exact fresh branch inventory before persisting each order line", async () => {
    const db = database();
    const result = await new PostgresOrderStore(db.pool).create(order);
    expect(result).toEqual({ outcome: "created", orderId: "order-1" });
    const inventoryCheck = db.statements.find(sql => sql.includes("FROM branch_inventory i")) ?? "";
    expect(inventoryCheck).toContain("i.product_variant_id = $3 AND i.sku = $4");
    expect(inventoryCheck).toContain("i.last_synced_at >= clock_timestamp()");
    expect(inventoryCheck).toContain("i.available_quantity - i.reserved_quantity >= $5");
    expect(inventoryCheck).toContain("FOR UPDATE");
  });

  it("rejects stale or insufficient branch inventory and rolls back order creation", async () => {
    const db = database({ inventoryEligible: false });
    await expect(new PostgresOrderStore(db.pool).create(order))
      .rejects.toThrow("Order item inventory is stale or insufficient");
    expect(db.statements.some(sql => sql.includes("INSERT INTO customer_order_items"))).toBe(false);
    expect(db.statements.at(-1)).toBe("ROLLBACK");
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it("rejects a caller-supplied currency that differs from the live catalog currency", async () => {
    const db = database({ catalogCurrency: "USD" });
    await expect(new PostgresOrderStore(db.pool).create(order))
      .rejects.toThrow("Order item price does not match the current published catalog price");
    expect(db.statements.some(sql => sql.includes("INSERT INTO customer_order_items"))).toBe(false);
    expect(db.statements.at(-1)).toBe("ROLLBACK");
  });

  it("returns already_exists only when the persisted order lines also match", async () => {
    const db = database({ existing: true });
    const result = await new PostgresOrderStore(db.pool).create(order);
    expect(result).toEqual({ outcome: "already_exists", orderId: "persisted-order" });
    expect(db.statements.some(sql => sql.includes("INSERT INTO customer_orders"))).toBe(false);
    expect(db.statements.at(-1)).toBe("COMMIT");
  });

  it("keeps idempotent order creation stable after a suborder lifecycle transition", async () => {
    const db = database({ existing: true, existingSuborderStatus: "preparing" });
    const result = await new PostgresOrderStore(db.pool).create(order);
    expect(result).toEqual({ outcome: "already_exists", orderId: "persisted-order" });
    expect(db.statements.some(sql => sql.includes("INSERT INTO customer_orders"))).toBe(false);
    expect(db.statements.at(-1)).toBe("COMMIT");
  });

  it("reports an idempotency conflict when the same key carries different totals", async () => {
    const db = database({ existing: true, existingTotal: "13000" });
    const result = await new PostgresOrderStore(db.pool).create(order);
    expect(result).toEqual({ outcome: "idempotency_conflict", orderId: "persisted-order" });
    expect(db.statements.some(sql => sql.includes("INSERT INTO customer_orders"))).toBe(false);
  });

  it("rejects malformed order input before opening a transaction", async () => {
    const db = database();
    await expect(new PostgresOrderStore(db.pool).create({
      ...order, idempotencyKey: "short", totalMinor: -1
    })).rejects.toThrow();
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  it("rejects a new suborder that attempts to skip pending validation", async () => {
    const db = database();
    const invalid = {
      ...order,
      suborders: [{ ...order.suborders[0]!, status: "awaiting_payment" as const }]
    };
    await expect(new PostgresOrderStore(db.pool).create(invalid))
      .rejects.toThrow("New merchant suborders must start in pending_validation");
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  it("rejects a suborder whose line totals do not equal its persisted subtotal", async () => {
    const db = database();
    const invalid = {
      ...order,
      suborders: [{ ...order.suborders[0]!, subtotalMinor: 12899 }]
    };
    await expect(new PostgresOrderStore(db.pool).create(invalid))
      .rejects.toThrow("Order item totals must equal the merchant suborder subtotal");
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  it("rejects duplicate product variants within one merchant suborder before opening a transaction", async () => {
    const db = database();
    const duplicate = {
      ...order,
      suborders: [{
        ...order.suborders[0]!,
        items: [
          order.suborders[0]!.items[0]!,
          { ...order.suborders[0]!.items[0]!, id: "item-2", quantity: 1, unitPriceMinor: 4300 }
        ],
        subtotalMinor: 17200
      }]
    };
    await expect(new PostgresOrderStore(db.pool).create(duplicate))
      .rejects.toThrow("A merchant suborder cannot contain duplicate product variants");
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  it("rejects an empty suborder line list", async () => {
    const db = database();
    const invalid = { ...order, suborders: [{ ...order.suborders[0]!, items: [] }] };
    await expect(new PostgresOrderStore(db.pool).create(invalid))
      .rejects.toThrow("A merchant suborder requires at least one order item");
    expect(db.pool.connect).not.toHaveBeenCalled();
  });
});
