import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { Actor } from "../../../packages/domain/src/authorization.js";
import type { MerchantCatalogImportService } from "../../../packages/domain/src/merchant-catalog-import-service.js";

const owner: Actor = {
  id: "owner-1", role: "merchant_owner", active: true,
  grants: [{ resource: "merchant.integration", actions: ["create"], scope: { merchantId: "merchant-1" } }]
};

describe("merchant catalog import route", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

  it("passes tenant and integration identity from the route, not the request body", async () => {
    let received: unknown;
    const service = {
      async import(input: unknown) {
        received = input;
        return { pagesImported: 1, productsImported: 4, completed: true };
      }
    } as unknown as MerchantCatalogImportService;
    const app = buildApp({ resolveActor: async () => owner, merchantCatalogImport: service });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/integrations/salla-main/catalog/import",
      payload: { sourceUrl: "https://shop.example", tenantId: "attacker", integrationId: "other" }
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({
      tenantId: "merchant-1", integrationId: "salla-main", sourceUrl: "https://shop.example"
    });
    expect(response.json().import.productsImported).toBe(4);
  });

  it("rejects unauthenticated imports", async () => {
    const app = buildApp({ resolveActor: async () => null });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/integrations/salla-main/catalog/import",
      payload: { sourceUrl: "https://shop.example" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("fails closed when no provider-backed import service is configured", async () => {
    const app = buildApp({ resolveActor: async () => owner });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/integrations/salla-main/catalog/import",
      payload: { sourceUrl: "https://shop.example" }
    });
    expect(response.statusCode).toBe(503);
  });

  it("rejects malformed cursors and timestamps", async () => {
    const service = { async import() { throw new Error("must-not-run"); } } as unknown as MerchantCatalogImportService;
    const app = buildApp({ resolveActor: async () => owner, merchantCatalogImport: service });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/integrations/salla-main/catalog/import",
      payload: { sourceUrl: "https://shop.example", cursor: 4 }
    });
    expect(response.statusCode).toBe(400);
  });
});
