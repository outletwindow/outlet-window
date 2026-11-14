import { describe, expect, it, vi } from "vitest";
import type { PostgresClient, PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresCustomerCartRepricingService } from "./postgres-customer-cart-repricing.js";

function setup(options: {
  version?: number; itemCount?: number; rows?: Record<string, unknown>[];
} = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: readonly unknown[]): Promise<PostgresQueryResult<any>> => {
    calls.push({ sql, ...(values === undefined ? {} : { values }) });
    if (sql.includes("FROM customer_carts")) return {
      rows: options.version === 0 ? [] : [{ id: "cart-1", customer_id: "customer-1", currency: "SAR", version: options.version ?? 7 }],
      rowCount: 1
    };
    if (sql.includes("COUNT(*)::int AS item_count")) return {
      rows: [{ item_count: options.itemCount ?? 2 }], rowCount: 1
    };
    if (sql.includes("FROM customer_cart_items ci")) return {
      rows: options.rows ?? [
        { item_id: "item-1", merchant_id: "merchant-1", branch_id: "branch-1", merchant_tenant_id: "tenant-1",
          product_variant_id: "variant-1", quantity: 2, title: "Shirt", sku: "SKU-1", currency: "SAR",
          price_minor: "12900", merchant_active: true, branch_active: true, product_published: true, stock_eligible: true },
        { item_id: "item-2", merchant_id: "merchant-2", branch_id: "branch-2", merchant_tenant_id: "tenant-2",
          product_variant_id: "variant-2", quantity: 1, title: "Shoes", sku: "SKU-2", currency: "SAR",
          price_minor: "24500", merchant_active: true, branch_active: true, product_published: true, stock_eligible: true }
      ], rowCount: options.rows?.length ?? 2
    };
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() } as unknown as PostgresClient;
  const pool = { query, connect: vi.fn(async () => client) } as unknown as PostgresPool;
  return { service: new PostgresCustomerCartRepricingService(pool), calls, query, client };
}

describe("PostgresCustomerCartRepricingService", () => {
  it("reprices from the live catalog and groups exact merchant branches while holding locks", async () => {
    const db = setup();
    const result = await db.service.reprice({ customerId: "customer-1", expectedCartVersion: 7 });
    expect(result).toMatchObject({
      outcome: "priced", cartId: "cart-1", cartVersion: 7, currency: "SAR",
      subtotalMinor: 50300,
      suborders: [
        { merchantId: "merchant-1", branchId: "branch-1", subtotalMinor: 25800 },
        { merchantId: "merchant-2", branchId: "branch-2", subtotalMinor: 24500 }
      ]
    });
    const lock = db.calls.findIndex(call => call.sql.includes("pg_advisory_xact_lock"));
    const header = db.calls.findIndex(call => call.sql.includes("FROM customer_carts"));
    const repricing = db.calls.findIndex(call => call.sql.includes("FROM customer_cart_items ci"));
    expect(lock).toBeLessThan(header);
    expect(header).toBeLessThan(repricing);
    expect(db.calls[repricing]?.sql).toContain("COALESCE(v.price_minor,p.price_minor)");
    expect(db.calls[repricing]?.sql).toContain("FOR UPDATE OF ci,v,p,m,b,i");
    expect(db.calls[repricing]?.sql).toContain("i.last_synced_at >= clock_timestamp()");
    expect(db.calls[repricing]?.sql).not.toContain("ci.price_minor");
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it("rejects a stale cart version before reading any line or catalog price", async () => {
    const db = setup({ version: 8 });
    const result = await db.service.reprice({ customerId: "customer-1", expectedCartVersion: 7 });
    expect(result).toEqual({ outcome: "version_conflict" });
    expect(db.calls.some(call => call.sql.includes("FROM customer_cart_items ci"))).toBe(false);
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("fails closed when inventory is stale, insufficient, or the merchant is inactive", async () => {
    const db = setup({ itemCount: 1, rows: [
      { item_id: "item-1", merchant_id: "merchant-1", branch_id: "branch-1", merchant_tenant_id: "tenant-1",
        product_variant_id: "variant-1", quantity: 2, title: "Shirt", sku: "SKU-1", currency: "SAR",
        price_minor: "12900", merchant_active: true, branch_active: true, product_published: true, stock_eligible: false }
    ] });
    const result = await db.service.reprice({ customerId: "customer-1", expectedCartVersion: 7 });
    expect(result).toEqual({ outcome: "unavailable", reason: "inventory_stale_or_insufficient" });
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rejects a joined-line count mismatch rather than silently dropping a cart item", async () => {
    const db = setup({ itemCount: 2, rows: [
      { item_id: "item-1", merchant_id: "merchant-1", branch_id: "branch-1", merchant_tenant_id: "tenant-1",
        product_variant_id: "variant-1", quantity: 1, title: "Shirt", sku: "SKU-1", currency: "SAR",
        price_minor: "12900", merchant_active: true, branch_active: true, product_published: true, stock_eligible: true }
    ] });
    const result = await db.service.reprice({ customerId: "customer-1", expectedCartVersion: 7 });
    expect(result).toEqual({ outcome: "unavailable", reason: "inventory_or_catalog_mapping_missing" });
  });

  it("rejects currency drift and unsafe catalog amounts", async () => {
    const db = setup({ itemCount: 1, rows: [
      { item_id: "item-1", merchant_id: "merchant-1", branch_id: "branch-1", merchant_tenant_id: "tenant-1",
        product_variant_id: "variant-1", quantity: 1, title: "Shirt", sku: "SKU-1", currency: "USD",
        price_minor: "12900", merchant_active: true, branch_active: true, product_published: true, stock_eligible: true }
    ] });
    const result = await db.service.reprice({ customerId: "customer-1", expectedCartVersion: 7 });
    expect(result).toEqual({ outcome: "invalid_snapshot", reason: "currency_mismatch" });
  });

  it("rolls back and releases the client if a database read fails", async () => {
    const db = setup();
    db.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      db.calls.push({ sql, ...(values === undefined ? {} : { values }) });
      if (sql.includes("FROM customer_cart_items ci")) throw new Error("catalog_read_failed");
      if (sql.includes("COUNT(*)::int AS item_count")) return { rows: [{ item_count: 2 }], rowCount: 1 };
      if (sql.includes("FROM customer_carts")) return { rows: [{ id: "cart-1", customer_id: "customer-1", currency: "SAR", version: 7 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    await expect(db.service.reprice({ customerId: "customer-1", expectedCartVersion: 7 })).rejects.toThrow("catalog_read_failed");
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(db.client.release).toHaveBeenCalledOnce();
  });
});
