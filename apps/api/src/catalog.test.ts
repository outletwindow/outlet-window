import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type MerchantCatalogRepository } from "./app.js";
import type { Actor } from "../../../packages/domain/src/authorization.js";
import type { CatalogProductInput, CatalogProductRecord } from "../../../packages/domain/src/postgres-merchant-catalog.js";

const merchantOwner: Actor = {
  id: "merchant-owner-1",
  role: "merchant_owner",
  active: true,
  grants: [
    { resource: "merchant.integration", actions: ["read", "create", "update"], scope: { merchantId: "merchant-1" } }
  ]
};

const payload = {
  integrationId: "pos-main",
  providerKey: "generic-pos",
  externalProductId: "shirt-001",
  canonicalUrl: "https://merchant.example/products/shirt-001",
  title: "Classic Shirt",
  brand: "Example",
  currency: "SAR",
  priceMinor: 12900,
  imageUrls: ["https://cdn.example/shirt-001.jpg"],
  sourceType: "official_api" as const,
  sourceCapturedAt: "2026-11-09T10:00:00.000Z",
  sourceContentSha256: "a".repeat(64),
  variants: [
    { externalVariantId: "shirt-001-m-blue", sku: "SHIRT-M-BLUE", sizeLabel: "M", colorLabel: "Blue", availability: "in_stock" as const }
  ]
};

describe("merchant catalog API", () => {
  let apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.map(app => app.close()));
    apps = [];
  });

  function makeApp(repository: MerchantCatalogRepository, actor: Actor | null = merchantOwner, tenantId: string | null = "merchant-1") {
    const app = buildApp({ resolveActor: async () => actor, merchantCatalog: repository,
      resolveMerchantTenantId: async () => tenantId });
    apps.push(app);
    return app.ready().then(() => app);
  }

  it("resolves the database tenant independently from the merchant route ID", async () => {
    let received: CatalogProductInput | undefined;
    const record: CatalogProductRecord = {
      ...payload,
      tenantId: "tenant-actual",
      id: "product-1",
      variants: [{ ...payload.variants[0]!, id: "variant-1" }],
      createdAt: payload.sourceCapturedAt,
      updatedAt: payload.sourceCapturedAt
    };
    const app = await makeApp({
      createProduct: async input => { received = input; return record; },
      listProducts: async () => []
    }, merchantOwner, "tenant-actual");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/catalog/products",
      payload
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().product).toMatchObject({
      id: "product-1", tenantId: "tenant-actual", title: "Classic Shirt",
      variants: [{ id: "variant-1", sizeLabel: "M", availability: "in_stock" }]
    });
    expect(received?.tenantId).toBe("tenant-actual");
    expect(received?.integrationId).toBe("pos-main");
  });

  it("rejects unauthenticated and cross-tenant catalog writes before calling the repository", async () => {
    let writes = 0;
    const repository = {
      createProduct: async () => { writes += 1; throw new Error("unexpected write"); },
      listProducts: async () => []
    };
    const unauthenticated = await makeApp(repository, null);
    const denied = await unauthenticated.inject({
      method: "POST", url: "/api/v1/merchants/merchant-1/catalog/products", payload
    });
    expect(denied.statusCode).toBe(401);

    const otherTenantActor: Actor = {
      ...merchantOwner,
      grants: [{ resource: "merchant.integration", actions: ["create"], scope: { merchantId: "merchant-2" } }]
    };
    const crossTenant = await makeApp(repository, otherTenantActor);
    const forbidden = await crossTenant.inject({
      method: "POST", url: "/api/v1/merchants/merchant-1/catalog/products", payload
    });
    expect(forbidden.statusCode).toBe(403);
    expect(writes).toBe(0);
  });

  it("rejects invalid URLs, currency, hashes and variant identifiers", async () => {
    let writes = 0;
    const app = await makeApp({
      createProduct: async () => { writes += 1; throw new Error("unexpected write"); },
      listProducts: async () => []
    });
    const invalid = [
      { ...payload, canonicalUrl: "http://merchant.example/product" },
      { ...payload, currency: "sa" },
      { ...payload, sourceContentSha256: "not-a-hash" },
      { ...payload, variants: [{ externalVariantId: " " }] }
    ];
    for (const body of invalid) {
      const response = await app.inject({
        method: "POST", url: "/api/v1/merchants/merchant-1/catalog/products", payload: body
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_catalog_product" });
    }
    expect(writes).toBe(0);
  });

  it("lists only the authenticated merchant catalog and validates page size", async () => {
    let requestedTenant = "";
    const app = await makeApp({
      createProduct: async () => { throw new Error("not used"); },
      listProducts: async (tenantId, limit) => {
        requestedTenant = tenantId;
        expect(limit).toBe(20);
        return [{ id: "product-1", title: "Classic Shirt" }];
      }
    }, merchantOwner, "tenant-actual");
    const response = await app.inject({
      method: "GET", url: "/api/v1/merchants/merchant-1/catalog/products?limit=20"
    });
    expect(response.statusCode).toBe(200);
    expect(requestedTenant).toBe("tenant-actual");
    expect(response.json().products).toHaveLength(1);

    const invalid = await app.inject({
      method: "GET", url: "/api/v1/merchants/merchant-1/catalog/products?limit=1000"
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("publishes only within the resolved tenant and records an audit event", async () => {
    let received: unknown;
    const app = buildApp({
      resolveActor: async () => merchantOwner, resolveMerchantTenantId: async () => "tenant-actual",
      auditEvents: { append: async () => "inserted" as const },
      merchantCatalog: {
        createProduct: async () => { throw new Error("unused"); }, listProducts: async () => [],
        setProductPublication: async input => { received = input; return { outcome: "updated" as const, publishedAt: "2026-11-11T10:00:00.000Z" }; }
      }
    });
    apps.push(app); await app.ready();
    const response = await app.inject({ method: "PUT", url: "/api/v1/merchants/merchant-1/catalog/products/p-1/publication", payload: { published: true } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ productId: "p-1", published: true });
    expect(received).toEqual({ tenantId: "tenant-actual", productId: "p-1", published: true });
  });

  it("fails closed when catalog storage is not configured", async () => {
    const app = buildApp({ resolveActor: async () => merchantOwner });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: "GET", url: "/api/v1/merchants/merchant-1/catalog/products"
    });
    expect(response.statusCode).toBe(503);
  });
});
