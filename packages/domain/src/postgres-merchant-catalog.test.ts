import { describe, expect, it, vi } from "vitest";
import type { PostgresClient, PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresMerchantCatalog, type CatalogProductInput } from "./postgres-merchant-catalog.js";

const input: CatalogProductInput = {
  tenantId: "merchant-a", integrationId: "pos-a", providerKey: "generic-pos",
  externalProductId: "shirt-1", canonicalUrl: "https://merchant.example/shirt-1",
  title: "Shirt", imageUrls: [], sourceType: "official_api",
  sourceCapturedAt: "2026-11-09T10:00:00.000Z", sourceContentSha256: "a".repeat(64),
  variants: [{ externalVariantId: "shirt-1-m", sizeLabel: "M", availability: "in_stock" }]
};

function setup(integrationExists = true) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: readonly unknown[]): Promise<PostgresQueryResult<any>> => {
    calls.push({ sql, ...(values === undefined ? {} : { values }) });
    if (sql.includes("FROM tenant_integrations")) {
      return { rows: integrationExists ? [{ id: "pos-a" }] : [], rowCount: integrationExists ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() } as unknown as PostgresClient;
  const pool = { connect: vi.fn(async () => client), query } as unknown as PostgresPool;
  return { repository: new PostgresMerchantCatalog(pool), calls, query, client, pool };
}

describe("PostgresMerchantCatalog", () => {
  it("creates a product and its variants in one tenant-scoped transaction", async () => {
    const state = setup();
    const result = await state.repository.createProduct(input);
    expect(result.tenantId).toBe("merchant-a");
    expect(result.variants).toHaveLength(1);
    expect(state.calls[0]?.sql).toBe("BEGIN");
    expect(state.calls.find(call => call.sql.includes("FROM tenant_integrations"))?.values)
      .toEqual(["merchant-a", "pos-a", "generic-pos"]);
    expect(state.calls.some(call => call.sql.includes("INSERT INTO commerce_catalog_products"))).toBe(true);
    expect(state.calls.some(call => call.sql.includes("INSERT INTO commerce_catalog_variants"))).toBe(true);
    expect(state.calls.at(-1)?.sql).toBe("COMMIT");
    expect(state.client.release).toHaveBeenCalledOnce();
  });

  it("refuses disconnected, missing, or cross-tenant integration references", async () => {
    const state = setup(false);
    await expect(state.repository.createProduct(input)).rejects.toThrow("CATALOG_INTEGRATION_NOT_CONNECTED");
    expect(state.calls.some(call => call.sql.includes("INSERT INTO commerce_catalog_products"))).toBe(false);
    expect(state.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(state.client.release).toHaveBeenCalledOnce();
  });

  it("rolls back all product writes when a variant insert fails", async () => {
    const state = setup();
    state.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      state.calls.push({ sql, ...(values === undefined ? {} : { values }) });
      if (sql.includes("FROM tenant_integrations")) return { rows: [{ id: "pos-a" }], rowCount: 1 };
      if (sql.includes("INSERT INTO commerce_catalog_variants")) throw new Error("variant write failed");
      return { rows: [], rowCount: 1 };
    });
    await expect(state.repository.createProduct(input)).rejects.toThrow("variant write failed");
    expect(state.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(state.client.release).toHaveBeenCalledOnce();
  });

  it("returns only published products with fresh, sellable stock for the exact branch", async () => {
    const state = setup();
    state.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      state.calls.push({ sql, ...(values === undefined ? {} : { values }) });
      return {
        rows: [{
          product_id: "product-1", title: "Shirt", description: null, brand: "Example",
          currency: "SAR", price_minor: "12000", image_urls: ["https://cdn.example/shirt.jpg"],
          variant_id: "variant-1", size_label: "M", color_label: "Blue",
          variant_currency: null, variant_price_minor: "12000"
        }],
        rowCount: 1
      };
    });
    const products = await state.repository.listPublishedBranchProducts({
      merchantId: "merchant-a", branchId: "branch-a", limit: 10
    });
    expect(state.calls[0]?.values).toEqual(["merchant-a", "branch-a", 10]);
    expect(state.calls[0]?.sql).toContain("p.published_at IS NOT NULL");
    expect(state.calls[0]?.sql).toContain("i.product_variant_id = v.external_variant_id");
    expect(state.calls[0]?.sql).toContain("i.sku = v.sku");
    expect(state.calls[0]?.sql).toContain("i.last_synced_at >= clock_timestamp() - interval '30 minutes'");
    expect(state.calls[0]?.sql).toContain("i.availability_confidence IN ('high','medium')");
    expect(state.calls[0]?.sql).toContain("i.available_quantity - i.reserved_quantity > 0");
    expect(products).toEqual([{
      id: "product-1", title: "Shirt", brand: "Example", currency: "SAR",
      priceMinor: 12000, imageUrls: ["https://cdn.example/shirt.jpg"],
      variants: [{
        id: "variant-1", sizeLabel: "M", colorLabel: "Blue",
        currency: "SAR", priceMinor: 12000, inStock: true
      }]
    }]);
  });

  it("rejects invalid branch discovery scopes before querying the database", async () => {
    const state = setup();
    await expect(state.repository.listPublishedBranchProducts({
      merchantId: " ", branchId: "branch-a", limit: 10
    })).rejects.toThrow("invalid_customer_catalog_scope");
    await expect(state.repository.listPublishedBranchProducts({
      merchantId: "merchant-a", branchId: "branch-a", limit: 101
    })).rejects.toThrow("invalid_customer_catalog_scope");
    expect(state.query).not.toHaveBeenCalled();
  });

  it("lists products with a tenant predicate and a bounded limit supplied by the API", async () => {
    const state = setup();
    state.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      state.calls.push({ sql, ...(values === undefined ? {} : { values }) });
      return { rows: [{ id: "product-1" }], rowCount: 1 };
    });
    const products = await state.repository.listProducts("merchant-a", 25);
    expect(products).toEqual([{ id: "product-1" }]);
    expect(state.calls[0]?.sql).toContain("WHERE p.tenant_id = $1");
    expect(state.calls[0]?.values).toEqual(["merchant-a", 25]);
  });
});
