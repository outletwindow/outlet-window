import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { Actor } from "../../../packages/domain/src/authorization.js";

const employee: Actor = {
  id: "employee-1",
  role: "merchant_employee",
  active: true,
  grants: [{
    resource: "merchant.branch.inventory",
    actions: ["read"],
    scope: { merchantId: "merchant-1", branchId: "branch-1" }
  }]
};

describe("branch inventory read API", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
  });

  it("returns only the authenticated branch inventory with a bounded limit", async () => {
    let received: unknown;
    const app = buildApp({
      resolveActor: async () => employee,
      resolveMerchantTenantId: async merchantId => merchantId === "merchant-1" ? "tenant-1" : null,
      branchInventoryReader: {
        async list(input) {
          received = input;
          return [{
            productVariantId: "variant-1", sku: "SKU-1",
            availableQuantity: 8, reservedQuantity: 2,
            source: "pos", lastSyncedAtUtc: "2026-11-09T10:00:00.000Z",
            confidence: "high"
          }];
        }
      }
    });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/merchants/merchant-1/branches/branch-1/inventory?limit=25"
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({
      tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1", limit: 25
    });
    expect(response.json().inventory[0]).toMatchObject({
      productVariantId: "variant-1", availableQuantity: 8, reservedQuantity: 2, confidence: "high"
    });
  });

  it("denies access to another branch before reading its stock", async () => {
    let calls = 0;
    const app = buildApp({
      resolveActor: async () => employee,
      resolveMerchantTenantId: async () => "tenant-1",
      branchInventoryReader: { async list() { calls += 1; return []; } }
    });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/merchants/merchant-1/branches/branch-2/inventory"
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toBe(0);
  });

  it("rejects invalid limits and fails closed when the read adapter is absent", async () => {
    const app = buildApp({ resolveActor: async () => employee });
    apps.push(app);
    await app.ready();

    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/merchants/merchant-1/branches/branch-1/inventory?limit=1000"
    });
    expect(invalid.statusCode).toBe(400);

    const unavailable = await app.inject({
      method: "GET",
      url: "/api/v1/merchants/merchant-1/branches/branch-1/inventory"
    });
    expect(unavailable.statusCode).toBe(503);
  });
});
