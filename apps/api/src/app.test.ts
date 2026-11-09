import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { vi } from "vitest";
import { buildApp } from "./app.js";
import type { Actor } from "../../../packages/domain/src/authorization.js";

const merchantActor: Actor = {
  id: "principal-1",
  role: "merchant_owner",
  active: true,
  grants: [{
    resource: "merchant.branch",
    actions: ["read"],
    scope: { merchantId: "merchant-1", branchId: "branch-1" }
  }]
};

describe("Outlet Window API foundation", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({ serviceName: "test-api", version: "test" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("verifies and atomically records a signed fulfillment handover webhook", async () => {
    const secret = "fulfillment-test-secret-with-at-least-32-characters";
    const recordAndApply = vi.fn(async () => ({ outcome: "applied" as const, receiptId: "receipt-1" }));
    const webhookApp = buildApp({
      fulfillmentHandoverInbox: { recordAndApply },
      fulfillmentWebhookSecretResolver: async key => key === "carrier-a" ? secret : null
    });
    await webhookApp.ready();
    try {
      const rawBody = JSON.stringify({
        eventType: "handover.completed", providerEventId: "event-1",
        tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1",
        reservationId: "reservation-1", handoverReference: "handover-1",
        occurredAtUtc: new Date().toISOString()
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", secret).update(timestamp + "." + rawBody).digest("hex");
      const response = await webhookApp.inject({
        method: "POST", url: "/api/v1/webhooks/fulfillment/carrier-a",
        headers: { "content-type": "application/json", "x-fulfillment-signature": `t=${timestamp},v1=${signature}` },
        payload: rawBody
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ outcome: "applied", receiptId: "receipt-1" });
      expect(recordAndApply).toHaveBeenCalledOnce();
      expect(recordAndApply.mock.calls[0]![0].event).toMatchObject({
        providerKey: "carrier-a", providerEventId: "event-1",
        handoverReference: "carrier-a:handover-1"
      });
    } finally {
      await webhookApp.close();
    }
  });

  it("rejects unsigned fulfillment handover events before persistence", async () => {
    const recordAndApply = vi.fn();
    const webhookApp = buildApp({
      fulfillmentHandoverInbox: { recordAndApply },
      fulfillmentWebhookSecretResolver: async () => "fulfillment-test-secret-with-at-least-32-characters"
    });
    await webhookApp.ready();
    try {
      const response = await webhookApp.inject({
        method: "POST", url: "/api/v1/webhooks/fulfillment/carrier-a",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ eventType: "handover.completed" })
      });
      expect(response.statusCode).toBe(401);
      expect(recordAndApply).not.toHaveBeenCalled();
    } finally {
      await webhookApp.close();
    }
  });

  it("exposes a health endpoint", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBeTruthy();
    expect(response.json()).toMatchObject({ status: "ok", service: "test-api", version: "test" });
  });

  it("exposes a readiness endpoint", async () => {
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ready");
  });

  it("reports not ready when a required database dependency is unavailable", async () => {
    const unavailableApp = buildApp({ readinessCheck: async () => false });
    await unavailableApp.ready();
    try {
      const response = await unavailableApp.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not_ready", checks: { process: "ok", database: "unavailable" } });
    } finally {
      await unavailableApp.close();
    }
  });

  it("reports not ready when the database health check throws", async () => {
    const unavailableApp = buildApp({ readinessCheck: async () => { throw new Error("db down"); } });
    await unavailableApp.ready();
    try {
      const response = await unavailableApp.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json().status).toBe("not_ready");
    } finally {
      await unavailableApp.close();
    }
  });

  it("exposes the versioned API foundation", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: "Outlet Window API", version: "v1" });
  });

  it("denies protected routes when no verified actor is resolved", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/merchants/merchant-1/branches/branch-1/access-check"
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthenticated" });
  });

  it("allows a verified actor only for its assigned merchant branch", async () => {
    const protectedApp = buildApp({ resolveActor: async () => merchantActor });
    await protectedApp.ready();
    try {
      const allowed = await protectedApp.inject({
        method: "GET",
        url: "/api/v1/merchants/merchant-1/branches/branch-1/access-check"
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual({ access: "granted" });

      const denied = await protectedApp.inject({
        method: "GET",
        url: "/api/v1/merchants/merchant-1/branches/branch-2/access-check"
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: "forbidden", reason: "scope_mismatch" });

      const otherMerchant = await protectedApp.inject({
        method: "GET",
        url: "/api/v1/merchants/merchant-2/branches/branch-1/access-check"
      });
      expect(otherMerchant.statusCode).toBe(403);
    } finally {
      await protectedApp.close();
    }
  });

  it("denies inactive actors even when they have a matching grant", async () => {
    const protectedApp = buildApp({
      resolveActor: async () => ({ ...merchantActor, active: false })
    });
    await protectedApp.ready();
    try {
      const response = await protectedApp.inject({
        method: "GET",
        url: "/api/v1/merchants/merchant-1/branches/branch-1/access-check"
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "forbidden", reason: "inactive_actor" });
    } finally {
      await protectedApp.close();
    }
  });
  it("checks branch authorization before reading merchant data", async () => {
    let repositoryCalls = 0;
    const reader = {
      async findBranchSummary(input: { merchantId: string; branchId: string }) {
        repositoryCalls += 1;
        return {
          merchantId: input.merchantId,
          branchId: input.branchId,
          displayName: "Branch One",
          status: "active" as const
        };
      }
    };
    const protectedApp = buildApp({
      resolveActor: async () => merchantActor,
      merchantBranches: reader
    });
    await protectedApp.ready();
    try {
      const denied = await protectedApp.inject({
        method: "GET",
        url: "/api/v1/merchants/merchant-1/branches/branch-2/summary"
      });
      expect(denied.statusCode).toBe(403);
      expect(repositoryCalls).toBe(0);

      const allowed = await protectedApp.inject({
        method: "GET",
        url: "/api/v1/merchants/merchant-1/branches/branch-1/summary"
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().branch).toMatchObject({
        merchantId: "merchant-1", branchId: "branch-1", displayName: "Branch One"
      });
      expect(repositoryCalls).toBe(1);
    } finally {
      await protectedApp.close();
    }
  });

  it("requires merchant-scoped create permission before branch creation", async () => {
    let writes = 0;
    const protectedApp = buildApp({
      resolveActor: async () => merchantActor,
      merchantBranchWriter: {
        createBranch: async () => { writes += 1; return "created"; },
        updateBranch: async () => "updated"
      }
    });
    await protectedApp.ready();
    try {
      const denied = await protectedApp.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-2/branches",
        payload: { branchId: "branch-2", displayName: "Jubail East", cityCode: "JUB" }
      });
      expect(denied.statusCode).toBe(403);
      expect(writes).toBe(0);

      const actorWithCreate: Actor = {
        ...merchantActor,
        grants: [{ resource: "merchant.branch", actions: ["create"], scope: { merchantId: "merchant-1" } }]
      };
      const createApp = buildApp({
        resolveActor: async () => actorWithCreate,
        merchantBranchWriter: {
          createBranch: async () => { writes += 1; return "created"; },
          updateBranch: async () => "updated"
        }
      });
      await createApp.ready();
      try {
        const allowed = await createApp.inject({
          method: "POST",
          url: "/api/v1/merchants/merchant-1/branches",
          payload: { branchId: "branch-2", displayName: "Jubail East", cityCode: "JUB" }
        });
        expect(allowed.statusCode).toBe(201);
        expect(writes).toBe(1);
      } finally {
        await createApp.close();
      }
    } finally {
      await protectedApp.close();
    }
  });

  it("validates branch creation payloads", async () => {
    const actorWithCreate: Actor = {
      ...merchantActor,
      grants: [{ resource: "merchant.branch", actions: ["create"], scope: { merchantId: "merchant-1" } }]
    };
    const protectedApp = buildApp({
      resolveActor: async () => actorWithCreate,
      merchantBranchWriter: { createBranch: async () => "created", updateBranch: async () => "updated" }
    });
    await protectedApp.ready();
    try {
      const response = await protectedApp.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/branches",
        payload: { branchId: "x", displayName: " ", cityCode: "jub" }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_request" });
    } finally {
      await protectedApp.close();
    }
  });

  it("requires branch-scoped update permission and validates update payloads", async () => {
    let updates = 0;
    const owner: Actor = {
      ...merchantActor,
      grants: [{ resource: "merchant.branch", actions: ["update"], scope: { merchantId: "merchant-1", branchId: "branch-1" } }]
    };
    const protectedApp = buildApp({
      resolveActor: async () => owner,
      merchantBranchWriter: {
        createBranch: async () => "created",
        updateBranch: async () => { updates += 1; return "updated"; }
      }
    });
    await protectedApp.ready();
    try {
      const denied = await protectedApp.inject({
        method: "PATCH",
        url: "/api/v1/merchants/merchant-1/branches/branch-2",
        payload: { displayName: "Changed", cityCode: "JUB", status: "active" }
      });
      expect(denied.statusCode).toBe(403);
      expect(updates).toBe(0);

      const allowed = await protectedApp.inject({
        method: "PATCH",
        url: "/api/v1/merchants/merchant-1/branches/branch-1",
        payload: { displayName: "Jubail Updated", cityCode: "JUB", status: "inactive" }
      });
      expect(allowed.statusCode).toBe(200);
      expect(updates).toBe(1);

      const invalid = await protectedApp.inject({
        method: "PATCH",
        url: "/api/v1/merchants/merchant-1/branches/branch-1",
        payload: { displayName: "x", cityCode: "JUB", status: "active" }
      });
      expect(invalid.statusCode).toBe(400);
      expect(updates).toBe(1);
    } finally {
      await protectedApp.close();
    }
  });

  it("persists authorization decisions using the verified actor and request scope", async () => {
    const events: import("../../../packages/domain/src/audit.js").AuditEvent[] = [];
    const protectedApp = buildApp({
      resolveActor: async () => merchantActor,
      auditEvents: { append: async event => { events.push(event); return "inserted"; } }
    });
    await protectedApp.ready();
    try {
      const allowed = await protectedApp.inject({ method: "GET", url: "/api/v1/merchants/merchant-1/branches/branch-1/access-check" });
      expect(allowed.statusCode).toBe(200);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor: { id: "principal-1", role: "merchant_owner", type: "merchant_user" },
        tenantId: "merchant-1", merchantId: "merchant-1", branchId: "branch-1",
        outcome: "success", source: "api"
      });
      expect(events[0]?.correlationId).toBe(allowed.headers["x-correlation-id"]);
      const denied = await protectedApp.inject({ method: "GET", url: "/api/v1/merchants/merchant-1/branches/branch-2/access-check" });
      expect(denied.statusCode).toBe(403);
      expect(events).toHaveLength(2);
      expect(events[1]?.outcome).toBe("denied");
      expect(events[1]?.actor.id).toBe("principal-1");
    } finally { await protectedApp.close(); }
  });

  it("does not execute a protected action when durable audit persistence fails", async () => {
    let repositoryCalls = 0;
    const protectedApp = buildApp({
      resolveActor: async () => merchantActor,
      auditEvents: { append: async () => { throw new Error("audit database unavailable"); } },
      merchantBranches: { findBranchSummary: async () => {
        repositoryCalls += 1;
        return { merchantId: "merchant-1", branchId: "branch-1", displayName: "Branch", status: "active" as const };
      } }
    });
    await protectedApp.ready();
    try {
      const response = await protectedApp.inject({ method: "GET", url: "/api/v1/merchants/merchant-1/branches/branch-1/summary" });
      expect(response.statusCode).toBe(500);
      expect(repositoryCalls).toBe(0);
    } finally { await protectedApp.close(); }
  });

  it("authorizes scoped merchant order transitions and derives the actor from the session", async () => {
    const operator: Actor = { ...merchantActor, grants: [{ resource: "merchant.order", actions: ["update"], scope: { merchantId: "merchant-1", branchId: "branch-1" } }] };
    const calls: Array<{ tenantId: string; context: { actorId: string; actorRole: string; paymentAuthorized?: boolean }; auditEvent: { actor: { id: string }; tenantId?: string; branchId?: string } }> = [];
    const protectedApp = buildApp({ resolveActor: async () => operator, orderTransitions: { transitionSuborder: async input => {
      calls.push(input);
      return { outcome: "updated", transition: { ok: true, previousStatus: "pending_validation", order: { status: "awaiting_payment", version: 2 } }, parentStatus: "awaiting_payment" };
    } } });
    await protectedApp.ready();
    try {
      const denied = await protectedApp.inject({ method: "POST", url: "/api/v1/merchants/merchant-1/branches/branch-2/orders/order-1/suborders/sub-1/transitions", payload: { nextStatus: "awaiting_payment", expectedVersion: 1 } });
      expect(denied.statusCode).toBe(403);
      expect(calls).toHaveLength(0);
      const allowed = await protectedApp.inject({ method: "POST", url: "/api/v1/merchants/merchant-1/branches/branch-1/orders/order-1/suborders/sub-1/transitions", payload: { nextStatus: "awaiting_payment", expectedVersion: 1 } });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({ suborder: { id: "sub-1", status: "awaiting_payment", version: 2 }, previousStatus: "pending_validation", parentStatus: "awaiting_payment" });
      expect(calls[0]?.tenantId).toBe("merchant-1");
      expect(calls[0]?.context).toMatchObject({ actorId: "principal-1", actorRole: "merchant_owner", paymentAuthorized: false });
      expect(calls[0]?.auditEvent).toMatchObject({ actor: { id: "principal-1" }, tenantId: "merchant-1", branchId: "branch-1" });
    } finally { await protectedApp.close(); }
  });

  it("rejects malformed order transition commands", async () => {
    const operator: Actor = { ...merchantActor, grants: [{ resource: "merchant.order", actions: ["update"], scope: { merchantId: "merchant-1", branchId: "branch-1" } }] };
    let writes = 0;
    const protectedApp = buildApp({ resolveActor: async () => operator, orderTransitions: { transitionSuborder: async () => { writes += 1; return { outcome: "not_found" }; } } });
    await protectedApp.ready();
    try {
      const response = await protectedApp.inject({ method: "POST", url: "/api/v1/merchants/merchant-1/branches/branch-1/orders/order-1/suborders/sub-1/transitions", payload: { nextStatus: "delivered", expectedVersion: 0, deliveryProofVerified: true } });
      expect(response.statusCode).toBe(400);
      expect(writes).toBe(0);
    } finally { await protectedApp.close(); }
  });

  it("requires a verified customer grant before changing a delivery destination", async () => {
    let updates = 0;
    const customer: Actor = {
      id: "customer-7", role: "customer", active: true,
      grants: [{ resource: "customer.order", actions: ["update"], scope: { orderId: "order-7" } }]
    };
    const protectedApp = buildApp({
      resolveActor: async () => customer,
      customerDeliveryDestinations: { update: async input => {
        updates += 1;
        expect(input).toEqual({
          customerId: "customer-7", actorId: "customer-7", orderId: "order-7",
          destination: { latitude: 27.01, longitude: 49.65 }
        });
        return {
          outcome: "updated", branchChanged: true,
          quote: {
            branchId: "branch-new", deliveryFeeMinor: 1500, totalMinor: 51500,
            currency: "SAR", estimatedDeliveryAtUtc: "2026-11-08T13:00:00.000Z",
            quoteReference: "server-quote", expiresAtUtc: "2026-11-08T12:05:00.000Z"
          }
        };
      } }
    });
    await protectedApp.ready();
    try {
      const denied = await protectedApp.inject({
        method: "PATCH", url: "/api/v1/customer/orders/order-other/delivery-destination",
        payload: { latitude: 27.01, longitude: 49.65 }
      });
      expect(denied.statusCode).toBe(403);
      expect(updates).toBe(0);

      const changed = await protectedApp.inject({
        method: "PATCH", url: "/api/v1/customer/orders/order-7/delivery-destination",
        payload: { latitude: 27.01, longitude: 49.65, totalMinor: 1, branchId: "attacker-branch" }
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({
        outcome: "updated", branchChanged: true,
        delivery: { branchId: "branch-new", totalMinor: 51500, quoteReference: "server-quote" }
      });
      expect(updates).toBe(1);
    } finally { await protectedApp.close(); }
  });

  it("rejects invalid customer destination coordinates before invoking pricing", async () => {
    const customer: Actor = {
      id: "customer-7", role: "customer", active: true,
      grants: [{ resource: "customer.order", actions: ["update"], scope: { orderId: "order-7" } }]
    };
    let updates = 0;
    const protectedApp = buildApp({
      resolveActor: async () => customer,
      customerDeliveryDestinations: { update: async () => { updates += 1; return { outcome: "not_found" }; } }
    });
    await protectedApp.ready();
    try {
      const response = await protectedApp.inject({
        method: "PATCH", url: "/api/v1/customer/orders/order-7/delivery-destination",
        payload: { latitude: 100, longitude: 49.65 }
      });
      expect(response.statusCode).toBe(400);
      expect(updates).toBe(0);
    } finally { await protectedApp.close(); }
  });


  it("returns a clear conflict when a delivery change needs a payment adjustment", async () => {
    const customer: Actor = {
      id: "customer-8", role: "customer", active: true,
      grants: [{ resource: "customer.order", actions: ["update"], scope: { orderId: "order-8" } }]
    };
    const protectedApp = buildApp({
      resolveActor: async () => customer,
      customerDeliveryDestinations: { update: async () => ({ outcome: "payment_adjustment_required" }) }
    });
    await protectedApp.ready();
    try {
      const response = await protectedApp.inject({
        method: "PATCH", url: "/api/v1/customer/orders/order-8/delivery-destination",
        payload: { latitude: 27.01, longitude: 49.65 }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "payment_adjustment_required",
        message: expect.stringContaining("authorized and confirmed")
      });
    } finally { await protectedApp.close(); }
  });

});


describe("signed payment provider webhook intake", () => {
  const secret = "s".repeat(48);
  const body = JSON.stringify({ id: "evt-api-1", type: "payment.adjustment", adjustmentId: "adjustment-1", status: "succeeded", providerReference: "psp-ref-api-1" });
  const makeSignature = (rawBody: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const digest = createHmac("sha256", secret).update(timestamp + "." + rawBody).digest("hex");
    return `t=${timestamp},v1=${digest}`;
  };

  it("verifies the exact raw body before durably recording a provider event", async () => {
    const record = vi.fn(async () => ({ outcome: "received" as const, receiptId: "receipt-api-1" }));
    const app = buildApp({
      paymentWebhookSecretResolver: async (providerKey) => providerKey === "psp-a" ? secret : null,
      paymentWebhookInbox: { record }
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/psp-a",
        headers: { "content-type": "application/json", "x-payment-signature": makeSignature(body) },
        payload: body
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ outcome: "received", receiptId: "receipt-api-1" });
      expect(record).toHaveBeenCalledWith({
        providerKey: "psp-a", providerEventId: "evt-api-1", adjustmentId: "adjustment-1", eventType: "payment.adjustment", normalizedStatus: "succeeded", providerReference: "psp-ref-api-1", rawBody: body
      });
    } finally { await app.close(); }
  });

  it("rejects invalid signatures without persisting the event", async () => {
    const record = vi.fn(async () => ({ outcome: "received" as const, receiptId: "unused" }));
    const app = buildApp({
      paymentWebhookSecretResolver: async () => secret,
      paymentWebhookInbox: { record }
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/psp-a",
        headers: { "content-type": "application/json", "x-payment-signature": "t=1794139200,v1=" + "0".repeat(64) },
        payload: body
      });
      expect(response.statusCode).toBe(401);
      expect(record).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
