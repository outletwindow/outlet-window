import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { Actor } from "../../../packages/domain/src/authorization.js";

const inventoryManager: Actor = {
  id: "merchant-owner-1",
  role: "merchant_owner",
  active: true,
  grants: [{
    resource: "merchant.branch.inventory",
    actions: ["read"],
    scope: { merchantId: "merchant-1", branchId: "branch-1" }
  }]
};

describe("branch inventory reconciliation alert API", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
  });

  it("returns open alerts using tenant and branch context resolved by the server", async () => {
    let received: unknown;
    const app = buildApp({
      resolveActor: async () => inventoryManager,
      resolveMerchantTenantId: async merchantId => merchantId === "merchant-1" ? "tenant-1" : null,
      branchInventoryReader: {
        async list() { return []; },
        async listOpenReconciliationAlerts(input) {
          received = input;
          return [{
            id: "alert-1", productVariantId: "variant-1", source: "pos",
            capturedAtUtc: "2026-11-14T12:00:00.000Z",
            reportedAvailableQuantity: 2, platformReservedQuantity: 5,
            createdAtUtc: "2026-11-14T12:01:00.000Z"
          }];
        }
      }
    });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/merchants/merchant-1/branches/branch-1/inventory/reconciliation-alerts?limit=10"
    });

    expect(response.statusCode).toBe(200);
    expect(received).toEqual({
      tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1", limit: 10
    });
    expect(response.json().alerts).toHaveLength(1);
    expect(response.json().alerts[0]).toMatchObject({
      id: "alert-1", reportedAvailableQuantity: 2, platformReservedQuantity: 5
    });
  });

  it("denies access outside the granted branch scope", async () => {
    let calls = 0;
    const app = buildApp({
      resolveActor: async () => inventoryManager,
      resolveMerchantTenantId: async () => "tenant-1",
      branchInventoryReader: {
        async list() { return []; },
        async listOpenReconciliationAlerts() { calls += 1; return []; }
      }
    });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/merchants/merchant-1/branches/branch-2/inventory/reconciliation-alerts"
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toBe(0);
  });
});
