import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { Actor } from "../../../packages/domain/src/authorization.js";
import type { BranchInventorySyncService } from "../../../packages/domain/src/branch-inventory-sync.js";

const inventoryManager: Actor = {
  id: "merchant-owner-1",
  role: "merchant_owner",
  active: true,
  grants: [{
    resource: "merchant.branch.inventory",
    actions: ["update"],
    scope: { merchantId: "merchant-1", branchId: "branch-1" }
  }]
};

describe("branch inventory sync API route", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
  });

  it("derives tenant and branch scope from trusted route context", async () => {
    let received: unknown;
    const sync = {
      async sync(input: unknown) {
        received = input;
        return { accepted: 1, stale: 0, confidence: "high", capturedAtUtc: "2026-11-09T08:00:00.000Z" };
      }
    } as unknown as BranchInventorySyncService;
    const app = buildApp({
      resolveActor: async () => inventoryManager,
      resolveMerchantTenantId: async merchantId => merchantId === "merchant-1" ? "tenant-1" : null,
      branchInventorySync: sync
    });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/branches/branch-1/inventory/sync",
      payload: {
        source: "pos",
        capturedAtUtc: "2026-11-09T08:00:00.000Z",
        lines: [{ productVariantId: "variant-1", sku: "SKU-1", availableQuantity: 7 }],
        tenantId: "attacker-tenant",
        merchantId: "attacker-merchant",
        branchId: "attacker-branch"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(received).toEqual({
      tenantId: "tenant-1",
      merchantId: "merchant-1",
      branchId: "branch-1",
      source: "pos",
      capturedAtUtc: "2026-11-09T08:00:00.000Z",
      lines: [{ productVariantId: "variant-1", sku: "SKU-1", availableQuantity: 7 }]
    });
    expect(response.json().result.accepted).toBe(1);
  });

  it("denies cross-branch access before invoking the inventory service", async () => {
    let calls = 0;
    const app = buildApp({
      resolveActor: async () => inventoryManager,
      resolveMerchantTenantId: async () => "tenant-1",
      branchInventorySync: { async sync() { calls += 1; throw new Error("must_not_run"); } }
    });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/branches/branch-2/inventory/sync",
      payload: {
        source: "pos",
        capturedAtUtc: "2026-11-09T08:00:00.000Z",
        lines: [{ productVariantId: "variant-1", sku: "SKU-1", availableQuantity: 7 }]
      }
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toBe(0);
  });

  it("rejects unauthenticated and malformed snapshots", async () => {
    const app = buildApp({
      resolveActor: async () => inventoryManager,
      resolveMerchantTenantId: async () => "tenant-1",
      branchInventorySync: { async sync() { throw new Error("must_not_run"); } }
    });
    apps.push(app);
    await app.ready();

    const unauthenticated = buildApp({
      resolveActor: async () => null,
      branchInventorySync: { async sync() { throw new Error("must_not_run"); } }
    });
    apps.push(unauthenticated);
    await unauthenticated.ready();

    const denied = await unauthenticated.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/branches/branch-1/inventory/sync",
      payload: { source: "pos", capturedAtUtc: "2026-11-09T08:00:00.000Z", lines: [] }
    });
    expect(denied.statusCode).toBe(401);

    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/branches/branch-1/inventory/sync",
      payload: { source: "unknown", capturedAtUtc: "not-a-date", lines: [] }
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: "invalid_inventory_snapshot" });
  });

  it("fails closed when the merchant tenant cannot be resolved", async () => {
    const app = buildApp({
      resolveActor: async () => inventoryManager,
      resolveMerchantTenantId: async () => null,
      branchInventorySync: { async sync() { throw new Error("must_not_run"); } }
    });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/branches/branch-1/inventory/sync",
      payload: {
        source: "pos",
        capturedAtUtc: "2026-11-09T08:00:00.000Z",
        lines: [{ productVariantId: "variant-1", sku: "SKU-1", availableQuantity: 7 }]
      }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "merchant_not_found" });
  });
});
