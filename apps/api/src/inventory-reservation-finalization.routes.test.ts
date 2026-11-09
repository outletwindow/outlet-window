import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { Actor } from "../../../packages/domain/src/authorization.js";

const branchManager: Actor = {
  id: "branch-manager-1",
  role: "branch_manager",
  active: true,
  grants: [{
    resource: "merchant.branch.inventory_reservation",
    actions: ["execute"],
    scope: { merchantId: "merchant-1", branchId: "branch-1" }
  }]
};

describe("branch-scoped inventory reservation finalization route", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
  });

  it("passes trusted merchant and branch scope to the lifecycle adapter", async () => {
    let received: unknown;
    const app = buildApp({
      resolveActor: async () => branchManager,
      resolveMerchantTenantId: async merchantId => merchantId === "merchant-1" ? "tenant-1" : null,
      inventoryReservationLifecycle: {
        async release(input) {
          received = input;
          return { outcome: "updated", status: "released" };
        },
        async expire() { throw new Error("must_not_run"); },
        async consume() { throw new Error("must_not_run"); }
      }
    });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/branches/branch-1/inventory/reservations/reservation-1/finalize",
      payload: { action: "release", reason: "merchant_cancelled" }
    });
    expect(response.statusCode).toBe(200);
    expect(received).toMatchObject({
      tenantId: "tenant-1",
      merchantId: "merchant-1",
      branchId: "branch-1",
      reservationId: "reservation-1",
      reason: "merchant_cancelled"
    });
    expect(response.json().result).toEqual({ outcome: "updated", status: "released" });
  });

  it("denies a branch manager from finalizing another branch reservation", async () => {
    let calls = 0;
    const app = buildApp({
      resolveActor: async () => branchManager,
      resolveMerchantTenantId: async () => "tenant-1",
      inventoryReservationLifecycle: {
        async release() { calls += 1; return { outcome: "updated", status: "released" }; },
        async expire() { calls += 1; return { outcome: "updated", status: "expired" }; },
        async consume() { calls += 1; return { outcome: "updated", status: "consumed" }; }
      }
    });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/branches/branch-2/inventory/reservations/reservation-1/finalize",
      payload: { action: "release", reason: "merchant_cancelled" }
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toBe(0);
  });

  it("does not accept client-asserted handover proof as inventory consumption", async () => {
    let consumeCalls = 0;
    const app = buildApp({
      resolveActor: async () => branchManager,
      resolveMerchantTenantId: async () => "tenant-1",
      inventoryReservationLifecycle: {
        async release() { throw new Error("must_not_run"); },
        async expire() { throw new Error("must_not_run"); },
        async consume() { consumeCalls += 1; return { outcome: "updated", status: "consumed" }; }
      }
    });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/branches/branch-1/inventory/reservations/reservation-1/finalize",
      payload: { action: "consume", handoverVerified: true, handoverReference: "fake-client-proof" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "verified_fulfillment_event_required" });
    expect(consumeCalls).toBe(0);
  });
});
