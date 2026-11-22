import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { vi } from "vitest";
import { buildApp } from "./app.js";
import type { Actor } from "../../../packages/domain/src/authorization.js";
import type { RecordPreparationCheckInput } from "../../../packages/domain/src/postgres-merchant-order-item-preparation.js";

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
      fulfillmentWebhookSecretResolver: async key => key === "carrier-a" ? secret : null,
      fulfillmentWebhookAuthorizationResolver: async (key, event) =>
        key === "carrier-a" && event.tenantId === "tenant-1" &&
        event.merchantId === "merchant-1" && event.branchId === "branch-1"
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
    } finally {
      await webhookApp.close();
    }
  });

  it("rejects a correctly signed fulfillment event outside the provider's assigned branch scope", async () => {
    const secret = "fulfillment-test-secret-with-at-least-32-characters";
    const recordAndApply = vi.fn();
    const webhookApp = buildApp({
      fulfillmentHandoverInbox: { recordAndApply },
      fulfillmentWebhookSecretResolver: async () => secret,
      fulfillmentWebhookAuthorizationResolver: async (_key, event) =>
        event.tenantId === "tenant-allowed" && event.merchantId === "merchant-allowed" &&
        event.branchId === "branch-allowed"
    });
    await webhookApp.ready();
    try {
      const rawBody = JSON.stringify({
        eventType: "handover.completed", providerEventId: "event-scope-1",
        tenantId: "tenant-other", merchantId: "merchant-other", branchId: "branch-other",
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
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "fulfillment_provider_scope_not_authorized" });
      expect(recordAndApply).not.toHaveBeenCalled();
    } finally {
      await webhookApp.close();
    }
  });

  it("rejects unsigned fulfillment handover events before persistence", async () => {
    const recordAndApply = vi.fn();
    const webhookApp = buildApp({
      fulfillmentHandoverInbox: { recordAndApply },
      fulfillmentWebhookSecretResolver: async () => "fulfillment-test-secret-with-at-least-32-characters",
      fulfillmentWebhookAuthorizationResolver: async () => true
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
    const protectedApp = buildApp({ resolveActor: async () => operator, resolveMerchantTenantId: async () => "tenant-merchant-1", orderTransitions: { transitionSuborder: async input => {
      calls.push(input);
      return { outcome: "updated", transition: { ok: true, previousStatus: "pending_validation", order: { status: "awaiting_payment", version: 2 } }, parentStatus: "awaiting_payment" };
    } } });
    await protectedApp.ready();
    try {
      const denied = await protectedApp.inject({ method: "POST", url: "/api/v1/merchants/merchant-1/branches/branch-2/orders/order-1/suborders/sub-1/transitions", payload: { nextStatus: "awaiting_payment", expectedVersion: 1 } });
      expect(denied.statusCode).toBe(403);
      expect(calls).toHaveLength(0);
      const forbiddenCheckout = await protectedApp.inject({ method: "POST", url: "/api/v1/merchants/merchant-1/branches/branch-1/orders/order-1/suborders/sub-1/transitions", payload: { nextStatus: "awaiting_payment", expectedVersion: 1 } });
      expect(forbiddenCheckout.statusCode).toBe(403);
      expect(forbiddenCheckout.json()).toEqual({ error: "customer_checkout_transition_only" });
      expect(calls).toHaveLength(0);
    } finally { await protectedApp.close(); }
  });

  it("fails closed when merchant tenant ownership cannot be resolved for an order transition", async () => {
    const operator: Actor = { ...merchantActor, grants: [{ resource: "merchant.order", actions: ["update"], scope: { merchantId: "merchant-1", branchId: "branch-1" } }] };
    const transitionSuborder = vi.fn(async () => ({ outcome: "not_found" as const }));
    const protectedApp = buildApp({
      resolveActor: async () => operator,
      resolveMerchantTenantId: async () => null,
      orderTransitions: { transitionSuborder }
    });
    await protectedApp.ready();
    try {
      const response = await protectedApp.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/branches/branch-1/orders/order-1/suborders/sub-1/transitions",
        payload: { nextStatus: "awaiting_payment", expectedVersion: 1 }
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "merchant_not_found" });
      expect(transitionSuborder).not.toHaveBeenCalled();
    } finally {
      await protectedApp.close();
    }
  });

  it("limits merchant employees to preparation transitions within their assigned branch", async () => {
    const employee: Actor = {
      id: "employee-1", role: "merchant_employee", active: true,
      grants: [{ resource: "merchant.order", actions: ["read", "update"], scope: { merchantId: "merchant-1", branchId: "branch-1" } }]
    };
    let writes = 0;
    const employeeApp = buildApp({
      resolveActor: async () => employee,
      resolveMerchantTenantId: async () => "tenant-merchant-1",
      orderTransitions: { transitionSuborder: async input => {
        writes += 1;
        return { outcome: "updated", transition: { ok: true, previousStatus: "preparing", order: { status: input.nextStatus, version: 3 } }, parentStatus: input.nextStatus };
      } }
    });
    await employeeApp.ready();
    try {
      const wrongBranch = await employeeApp.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/branches/branch-2/orders/order-1/suborders/sub-1/transitions",
        payload: { nextStatus: "preparing", expectedVersion: 2 }
      });
      expect(wrongBranch.statusCode).toBe(403);
      const forbiddenStatus = await employeeApp.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/branches/branch-1/orders/order-1/suborders/sub-1/transitions",
        payload: { nextStatus: "cancelled", expectedVersion: 2, reason: "not permitted" }
      });
      expect(forbiddenStatus.statusCode).toBe(403);
      expect(forbiddenStatus.json()).toEqual({ error: "employee_preparation_transition_only" });
      expect(writes).toBe(0);
      const allowed = await employeeApp.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/branches/branch-1/orders/order-1/suborders/sub-1/transitions",
        payload: { nextStatus: "ready_for_pickup", expectedVersion: 2 }
      });
      expect(allowed.statusCode).toBe(200);
      expect(writes).toBe(1);
    } finally {
      await employeeApp.close();
    }
  });

  it("records preparation checks only for an employee's assigned branch and uses the authenticated actor", async () => {
    const employee: Actor = {
      id: "employee-prep-1", role: "merchant_employee", active: true,
      grants: [{ resource: "merchant.order", actions: ["read", "update"], scope: { merchantId: "merchant-1", branchId: "branch-1" } }]
    };
    const record = vi.fn(async (_input: RecordPreparationCheckInput) => ({
      outcome: "recorded" as const, expectedSku: "SKU-DB", expectedQuantity: 2
    }));
    const prepApp = buildApp({
      resolveActor: async () => employee,
      resolveMerchantTenantId: async merchantId => merchantId === "merchant-1" ? "tenant-1" : null,
      merchantOrderItemPreparation: { record }
    });
    await prepApp.ready();
    try {
      const base = "/api/v1/merchants/merchant-1/branches/";
      const denied = await prepApp.inject({
        method: "POST", url: base + "branch-2/orders/order-1/suborders/sub-1/items/item-1/preparation-checks",
        payload: { scannedSku: "SKU-DB", verifiedQuantity: 2, outcome: "verified" }
      });
      expect(denied.statusCode).toBe(403);
      expect(record).not.toHaveBeenCalled();

      const accepted = await prepApp.inject({
        method: "POST", url: base + "branch-1/orders/order-1/suborders/sub-1/items/item-1/preparation-checks",
        payload: { scannedSku: "SKU-DB", verifiedQuantity: 2, outcome: "verified", expectedSku: "CLIENT-FORGED", expectedQuantity: 999 }
      });
      expect(accepted.statusCode).toBe(201);
      expect(record).toHaveBeenCalledOnce();
      expect(record.mock.calls[0]![0]).toMatchObject({
        tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1",
        orderId: "order-1", suborderId: "sub-1", orderItemId: "item-1",
        actorId: "employee-prep-1", scannedSku: "SKU-DB", verifiedQuantity: 2, outcome: "verified"
      });
      expect(record.mock.calls[0]![0]).not.toHaveProperty("expectedSku");
      expect(record.mock.calls[0]![0]).not.toHaveProperty("expectedQuantity");
    } finally {
      await prepApp.close();
    }
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

  it("creates a customer payment intent only for the authenticated order owner and forwards the idempotency key", async () => {
    const customer: Actor = {
      id: "customer-payment-1", role: "customer", active: true,
      grants: [{ resource: "customer.order", actions: ["update"], scope: { orderId: "payment-order-1" } }]
    };
    const create = vi.fn(async () => ({
      outcome: "created" as const, providerPaymentReference: "provider-intent-1",
      clientSecret: "pi_secret_test_secret_123456", expiresAtUtc: "2026-11-10T22:30:00.000Z",
      amountMinor: 12500, currency: "SAR"
    }));
    const protectedApp = buildApp({
      resolveActor: async () => customer,
      customerPaymentIntentCheckout: { create }
    });
    await protectedApp.ready();
    try {
      const denied = await protectedApp.inject({
        method: "POST", url: "/api/v1/customer/orders/payment-order-other/payment-intents",
        headers: { "idempotency-key": "checkout-key-0001" }
      });
      expect(denied.statusCode).toBe(403);
      expect(create).not.toHaveBeenCalled();

      const created = await protectedApp.inject({
        method: "POST", url: "/api/v1/customer/orders/payment-order-1/payment-intents",
        headers: { "idempotency-key": "checkout-key-0001" }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ outcome: "created", amountMinor: 12500, currency: "SAR" });
      expect(create).toHaveBeenCalledWith({
        customerId: "customer-payment-1", orderId: "payment-order-1", idempotencyKey: "checkout-key-0001"
      });
    } finally { await protectedApp.close(); }
  });

  it("requires an idempotency key before creating a customer payment intent", async () => {
    const customer: Actor = {
      id: "customer-payment-2", role: "customer", active: true,
      grants: [{ resource: "customer.order", actions: ["update"], scope: { orderId: "payment-order-2" } }]
    };
    const create = vi.fn();
    const protectedApp = buildApp({ resolveActor: async () => customer, customerPaymentIntentCheckout: { create } });
    await protectedApp.ready();
    try {
      const response = await protectedApp.inject({
        method: "POST", url: "/api/v1/customer/orders/payment-order-2/payment-intents"
      });
      expect(response.statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();
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

  it("routes signed initial payment capture events only to the trusted capture processor", async () => {
    const captureBody = JSON.stringify({
      id: "evt-capture-api", type: "payment.captured",
      paymentReference: "intent-from-provider", amountMinor: 12500, currency: "SAR",
      capturedAtUtc: new Date().toISOString(), orderId: "client-forged-order"
    });
    const signatureHeader = makeSignature(captureBody);
    const process = vi.fn(async () => ({ outcome: "recorded" as const, captureId: "capture-api-1" }));
    const record = vi.fn(async () => ({ outcome: "received" as const, receiptId: "wrong-path" }));
    const app = buildApp({
      paymentCaptureWebhookHandler: { process }
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/psp-a",
        headers: { "content-type": "application/json", "x-payment-signature": signatureHeader },
        payload: captureBody
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ outcome: "recorded", captureId: "capture-api-1" });
      expect(process).toHaveBeenCalledWith({
        providerKey: "psp-a", rawBody: captureBody, signatureHeader
      });
      expect(record).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("routes native Moyasar payment_captured events to the trusted capture processor", async () => {
    const captureBody = JSON.stringify({
      id: "evt-moyasar-capture", type: "payment_captured",
      created_at: "2026-11-10T07:00:00.000Z",
      secret_token: "moyasar-secret", account_name: "Outlet Window", live: false,
      data: {
        id: "pay-moyasar-123", status: "captured", amount: 12500,
        captured: 5000, currency: "SAR", captured_at: "2026-11-10T06:59:00.000Z"
      }
    });
    const process = vi.fn(async () => ({ outcome: "recorded" as const, captureId: "capture-moyasar-1" }));
    const app = buildApp({ paymentCaptureWebhookHandler: { process } });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/moyasar",
        headers: { "content-type": "application/json" },
        payload: captureBody
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ outcome: "recorded", captureId: "capture-moyasar-1" });
      expect(process).toHaveBeenCalledWith({ providerKey: "moyasar", rawBody: captureBody });
    } finally { await app.close(); }
  });

  it("routes native Moyasar payment_paid purchase events to the trusted capture processor", async () => {
    const purchaseBody = JSON.stringify({
      id: "evt-moyasar-paid", type: "payment_paid",
      created_at: "2026-11-10T07:00:00.000Z",
      secret_token: "moyasar-secret", account_name: "Outlet Window", live: false,
      data: {
        id: "pay-moyasar-paid", status: "paid", amount: 12500,
        captured: 0, currency: "SAR", captured_at: null,
        updated_at: "2026-11-10T06:59:00.000Z"
      }
    });
    const process = vi.fn(async () => ({ outcome: "recorded" as const, captureId: "capture-paid-1" }));
    const app = buildApp({ paymentCaptureWebhookHandler: { process } });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/moyasar",
        headers: { "content-type": "application/json" },
        payload: purchaseBody
      });
      expect(response.statusCode).toBe(201);
      expect(process).toHaveBeenCalledWith({ providerKey: "moyasar", rawBody: purchaseBody });
    } finally { await app.close(); }
  });

  it("rejects malformed provider event identifiers before webhook persistence", async () => {
    const malformedBody = JSON.stringify({
      id: "evt api/1", type: "payment.adjustment", adjustmentId: "adjustment-1",
      status: "succeeded", providerReference: "psp-ref-api-1"
    });
    const record = vi.fn(async () => ({ outcome: "received" as const, receiptId: "unused" }));
    const app = buildApp({
      paymentWebhookSecretResolver: async () => secret,
      paymentWebhookInbox: { record }
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/psp-a",
        headers: { "content-type": "application/json", "x-payment-signature": makeSignature(malformedBody) },
        payload: malformedBody
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_webhook_event" });
      expect(record).not.toHaveBeenCalled();
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

  it("requires an authenticated customer and idempotency key before starting checkout", async () => {
    const create = vi.fn();
    const noIdentity = buildApp({ customerPaymentIntentCheckout: { create } });
    await noIdentity.ready();
    try {
      const response = await noIdentity.inject({ method: "POST", url: "/api/v1/customer/orders/order-1/payment-intents" });
      expect(response.statusCode).toBe(401);
      expect(create).not.toHaveBeenCalled();
    } finally { await noIdentity.close(); }

    const customer: Actor = {
      id: "customer-1", role: "customer", active: true,
      grants: [{ resource: "customer.order", actions: ["update"], scope: { orderId: "order-1" } }]
    };
    const protectedApp = buildApp({ resolveActor: async () => customer, customerPaymentIntentCheckout: { create } });
    await protectedApp.ready();
    try {
      const response = await protectedApp.inject({ method: "POST", url: "/api/v1/customer/orders/order-1/payment-intents" });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "idempotency_key_required" });
      expect(create).not.toHaveBeenCalled();
    } finally { await protectedApp.close(); }
  });

  it("does not allow a non-customer actor to start customer checkout", async () => {
    const create = vi.fn();
    const nonCustomerWithOrderGrant: Actor = {
      ...merchantActor,
      grants: [{ resource: "customer.order", actions: ["update"], scope: { orderId: "order-1" } }]
    };
    const app = buildApp({
      resolveActor: async () => nonCustomerWithOrderGrant,
      customerPaymentIntentCheckout: { create }
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/customer/orders/order-1/payment-intents",
        headers: { "idempotency-key": "checkout-api-key-0001" }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "customer_only" });
      expect(create).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("returns unavailable when payment checkout is not configured", async () => {
    const customer: Actor = {
      id: "customer-1", role: "customer", active: true,
      grants: [{ resource: "customer.order", actions: ["update"], scope: { orderId: "order-1" } }]
    };
    const app = buildApp({ resolveActor: async () => customer });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/customer/orders/order-1/payment-intents",
        headers: { "idempotency-key": "checkout-api-key-0001" }
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "payment_checkout_unavailable" });
    } finally { await app.close(); }
  });

  it("maps checkout outcomes to safe HTTP responses without leaking provider credentials", async () => {
    const customer: Actor = {
      id: "customer-1", role: "customer", active: true,
      grants: [{ resource: "customer.order", actions: ["update"], scope: { orderId: "order-1" } }]
    };
    const create = vi.fn(async () => ({
      outcome: "created" as const, providerPaymentReference: "provider-intent-1",
      clientSecret: "pi_secret_test_only", expiresAtUtc: "2026-11-10T22:30:00.000Z",
      amountMinor: 12500, currency: "SAR"
    }));
    const app = buildApp({ resolveActor: async () => customer, customerPaymentIntentCheckout: { create } });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/customer/orders/order-1/payment-intents",
        headers: { "idempotency-key": "checkout-api-key-0001" }
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        outcome: "created", providerPaymentReference: "provider-intent-1",
        clientSecret: "pi_secret_test_only", amountMinor: 12500, currency: "SAR"
      });
      expect(create).toHaveBeenCalledWith({
        customerId: "customer-1", orderId: "order-1", idempotencyKey: "checkout-api-key-0001"
      });
    } finally { await app.close(); }
  });

  it("maps an unknown provider outcome to HTTP 202 and recovery outage to HTTP 503", async () => {
    const customer: Actor = {
      id: "customer-1", role: "customer", active: true,
      grants: [{ resource: "customer.order", actions: ["update"], scope: { orderId: "order-1" } }]
    };
    let outcome: "outcome_unknown" | "recovery_unavailable" = "outcome_unknown";
    const app = buildApp({
      resolveActor: async () => customer,
      customerPaymentIntentCheckout: { create: async () => ({ outcome }) }
    });
    await app.ready();
    try {
      const request = () => app.inject({
        method: "POST", url: "/api/v1/customer/orders/order-1/payment-intents",
        headers: { "idempotency-key": "checkout-api-key-0001" }
      });
      const unknown = await request();
      expect(unknown.statusCode).toBe(202);
      expect(unknown.json()).toEqual({ outcome: "outcome_unknown" });
      outcome = "recovery_unavailable";
      const unavailable = await request();
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({ error: "payment_intent_recovery_unavailable" });
    } finally { await app.close(); }
  });


  it("exposes customer cart routes only to the authenticated customer's explicit cart scope", async () => {
    const customer: Actor = {
      id: "cart-customer-1", role: "customer", active: true,
      grants: [{ resource: "customer.cart", actions: ["read", "create", "delete"], scope: { customerId: "cart-customer-1" } }]
    };
    const cart = { id: "cart-1", customerId: "cart-customer-1", currency: "SAR", version: 2, items: [] };
    const get = vi.fn(async () => cart);
    const addItem = vi.fn(async () => cart);
    const removeItem = vi.fn(async () => cart);
    const cartApp = buildApp({ resolveActor: async () => customer, customerCart: { get, addItem, removeItem } });
    await cartApp.ready();
    try {
      const read = await cartApp.inject({ method: "GET", url: "/api/v1/customer/cart" });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ cart });
      const add = await cartApp.inject({
        method: "POST", url: "/api/v1/customer/cart/items",
        payload: { merchantId: "merchant-1", branchId: "branch-1", productVariantId: "variant-1", quantity: 2 }
      });
      expect(add.statusCode).toBe(200);
      expect(addItem).toHaveBeenCalledWith({
        customerId: "cart-customer-1", merchantId: "merchant-1", branchId: "branch-1",
        productVariantId: "variant-1", quantity: 2
      });
      const remove = await cartApp.inject({ method: "DELETE", url: "/api/v1/customer/cart/items/item-1" });
      expect(remove.statusCode).toBe(200);
      expect(removeItem).toHaveBeenCalledWith({ customerId: "cart-customer-1", itemId: "item-1" });
      expect(get).toHaveBeenCalledWith({ customerId: "cart-customer-1" });
    } finally {
      await cartApp.close();
    }
  });

  it("creates checkout only from the authenticated customer's cart scope and idempotency key", async () => {
    const customer: Actor = {
      id: "checkout-customer-1", role: "customer", active: true,
      grants: [{ resource: "customer.cart", actions: ["create"], scope: { customerId: "checkout-customer-1" } }]
    };
    const create = vi.fn(async () => ({
      outcome: "created" as const, orderId: "order-checkout-1", suborderIds: ["suborder-1"],
      totalMinor: 3500, currency: "SAR"
    }));
    const checkoutApp = buildApp({ resolveActor: async () => customer, customerCheckout: { create } });
    await checkoutApp.ready();
    try {
      const payload = {
        expectedCartVersion: 2,
        destination: { countryCode: "SA", cityCode: "JUBAIL", serviceCode: "standard_delivery",
          latitude: 27.01, longitude: 49.65, addressSnapshot: { label: "Home" } }
      };
      const missingKey = await checkoutApp.inject({
        method: "POST", url: "/api/v1/customer/checkout", payload
      });
      expect(missingKey.statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();

      const response = await checkoutApp.inject({
        method: "POST", url: "/api/v1/customer/checkout",
        headers: { "idempotency-key": "checkout-api-key-0001" }, payload
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ outcome: "created", orderId: "order-checkout-1" });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        customerId: "checkout-customer-1", expectedCartVersion: 2,
        idempotencyKey: "checkout-api-key-0001", actorId: "checkout-customer-1",
        actorRole: "customer"
      }));
    } finally {
      await checkoutApp.close();
    }
  });

  it("rejects checkout when the customer cart grant belongs to another customer", async () => {
    const customer: Actor = {
      id: "checkout-customer-1", role: "customer", active: true,
      grants: [{ resource: "customer.cart", actions: ["create"], scope: { customerId: "checkout-customer-other" } }]
    };
    const create = vi.fn();
    const checkoutApp = buildApp({ resolveActor: async () => customer, customerCheckout: { create } });
    await checkoutApp.ready();
    try {
      const response = await checkoutApp.inject({
        method: "POST", url: "/api/v1/customer/checkout",
        headers: { "idempotency-key": "checkout-api-key-0001" },
        payload: { expectedCartVersion: 1, destination: {
          countryCode: "SA", cityCode: "JUBAIL", serviceCode: "standard_delivery",
          latitude: 27.01, longitude: 49.65
        } }
      });
      expect(response.statusCode).toBe(403);
      expect(create).not.toHaveBeenCalled();
    } finally {
      await checkoutApp.close();
    }
  });

  it("rejects customer cart access when the grant belongs to a different customer", async () => {
    const customer: Actor = {
      id: "cart-customer-1", role: "customer", active: true,
      grants: [{ resource: "customer.cart", actions: ["read"], scope: { customerId: "cart-customer-other" } }]
    };
    const get = vi.fn(async () => null);
    const cartApp = buildApp({ resolveActor: async () => customer, customerCart: { get, addItem: vi.fn(), removeItem: vi.fn() } });
    await cartApp.ready();
    try {
      const response = await cartApp.inject({ method: "GET", url: "/api/v1/customer/cart" });
      expect(response.statusCode).toBe(403);
      expect(get).not.toHaveBeenCalled();
    } finally {
      await cartApp.close();
    }
  });

});


describe("customer payment adjustment consent submission", () => {
  it("returns accepted-for-processing only after consent and provider submission are durably queued", async () => {
    const customer: Actor = {
      id: "payment-customer-1", role: "customer", active: true,
      grants: [{
        resource: "customer.order", actions: ["update"], scope: { orderId: "payment-order-1" }
      }]
    };
    const consentAndQueue = vi.fn(async () => ({
      outcome: "provider_pending" as const, submissionId: "submission-1"
    }));
    const consent = vi.fn(async () => ({ outcome: "consented" as const }));
    const api = buildApp({
      resolveActor: async () => customer,
      customerPaymentAdjustments: { consent, consentAndQueue, decline: vi.fn(async () => ({ outcome: "declined" })) }
    });
    await api.ready();
    try {
      const response = await api.inject({
        method: "POST",
        url: "/api/v1/customer/orders/payment-order-1/payment-adjustments/adjustment-1/consent"
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        outcome: "provider_pending", submissionId: "submission-1",
        message: expect.stringContaining("provider confirmation is still pending")
      });
      expect(consentAndQueue).toHaveBeenCalledWith({
        orderId: "payment-order-1", adjustmentId: "adjustment-1", customerId: "payment-customer-1"
      });
      expect(consent).not.toHaveBeenCalled();
    } finally {
      await api.close();
    }
  });
});


describe("Moyasar refund webhook route", () => {
  const rawBody = JSON.stringify({
    id: "evt-refund-route", type: "payment_refunded",
    created_at: "2026-11-16T18:00:00.000Z", live: false,
    account_name: "Outlet Window Test", secret_token: "test-secret",
    data: {
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6", status: "refunded",
      amount: 10000, captured: 10000, refunded: 2500, currency: "SAR"
    }
  });

  it("routes native payment_refunded events only to the dedicated refund reconciler", async () => {
    const process = vi.fn(async () => ({ outcome: "applied" as const }));
    const app = buildApp({ paymentRefundWebhookHandler: { process } });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/moyasar",
        headers: { "content-type": "application/json" }, payload: rawBody
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ outcome: "applied" });
      expect(process).toHaveBeenCalledWith({ providerKey: "moyasar", rawBody });
    } finally { await app.close(); }
  });

  it("rejects oversized refund webhook requests at the HTTP boundary before invoking the reconciler", async () => {
    const process = vi.fn(async () => ({ outcome: "applied" as const }));
    const app = buildApp({ paymentRefundWebhookHandler: { process } });
    await app.ready();
    try {
      const oversizedBody = JSON.stringify({
        ...JSON.parse(rawBody),
        padding: "x".repeat(65_536)
      });
      const response = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/moyasar",
        headers: { "content-type": "application/json" }, payload: oversizedBody
      });
      expect(response.statusCode).toBe(413);
      expect(process).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("returns accepted while mismatched refund events are quarantined", async () => {
    const process = vi.fn(async () => ({ outcome: "reconciliation_required" as const }));
    const app = buildApp({ paymentRefundWebhookHandler: { process } });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/moyasar",
        headers: { "content-type": "application/json" }, payload: rawBody
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ outcome: "reconciliation_required" });
    } finally { await app.close(); }
  });

  it("does not acknowledge invalid signatures or event identity collisions", async () => {
    const invalid = buildApp({
      paymentRefundWebhookHandler: { process: vi.fn(async () => ({ outcome: "invalid_signature_or_event" as const })) }
    });
    await invalid.ready();
    try {
      const response = await invalid.inject({
        method: "POST", url: "/api/v1/webhooks/payments/moyasar",
        headers: { "content-type": "application/json" }, payload: rawBody
      });
      expect(response.statusCode).toBe(401);
    } finally { await invalid.close(); }

    const collision = buildApp({
      paymentRefundWebhookHandler: { process: vi.fn(async () => ({ outcome: "event_id_collision" as const })) }
    });
    await collision.ready();
    try {
      const response = await collision.inject({
        method: "POST", url: "/api/v1/webhooks/payments/moyasar",
        headers: { "content-type": "application/json" }, payload: rawBody
      });
      expect(response.statusCode).toBe(409);
    } finally { await collision.close(); }
  });
});


describe("courier delivery task API", () => {
  it("lists only the authenticated courier's tenant-scoped tasks", async () => {
    const courier: Actor = {
      id: "courier-principal-1", role: "courier", active: true,
      grants: [{
        resource: "courier.delivery_task", actions: ["read", "update"],
        scope: { merchantId: "merchant-courier-1" }
      }]
    };
    const listForCourier = vi.fn(async (input: { tenantId: string; courierId: string }) => [{
      id: "task-1", tenantId: input.tenantId, orderId: "order-1", suborderId: "suborder-1",
      courierId: input.courierId, status: "offered" as const, version: 1, updatedAtUtc: new Date().toISOString(),
      pickupCode: "00427193"
    }]);
    const transition = vi.fn(async () => ({
      outcome: "updated" as const,
      task: { id: "task-1", tenantId: "merchant-courier-1", orderId: "order-1",
        suborderId: "suborder-1", courierId: courier.id, status: "accepted" as const,
        version: 2, updatedAtUtc: new Date().toISOString(), pickupCode: "00427193" }
    }));
    const api = buildApp({ resolveActor: async () => courier, courierTasks: { listForCourier, transition } });
    await api.ready();
    try {
      const listed = await api.inject({ method: "GET", url: "/api/v1/courier/tasks" });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().tasks).toHaveLength(1);
      expect(listed.json().tasks[0]).not.toHaveProperty("pickupCode");
      expect(listForCourier).toHaveBeenCalledWith({
        tenantId: "merchant-courier-1", courierId: courier.id, limit: 100
      });

      const changed = await api.inject({
        method: "PATCH", url: "/api/v1/courier/tasks/task-1/status",
        payload: { status: "accepted", expectedVersion: 1 }
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().task).not.toHaveProperty("pickupCode");
      expect(transition).toHaveBeenCalledWith({
        tenantId: "merchant-courier-1", taskId: "task-1", courierId: courier.id,
        nextStatus: "accepted", expectedVersion: 1
      });
    } finally {
      await api.close();
    }
  });

  it("rejects malformed pickup codes before attempting a task transition", async () => {
    const courier: Actor = {
      id: "courier-pickup-format", role: "courier", active: true,
      grants: [{
        resource: "courier.delivery_task", actions: ["update"],
        scope: { merchantId: "merchant-pickup-format" }
      }]
    };
    const transition = vi.fn(async () => ({ outcome: "not_found" as const }));
    const api = buildApp({ resolveActor: async () => courier, courierTasks: {
      listForCourier: vi.fn(async () => []), transition
    } });
    await api.ready();
    try {
      for (const pickupCode of ["1234567", "123456789", "12A45678", " 1234567"]) {
        const response = await api.inject({
          method: "PATCH", url: "/api/v1/courier/tasks/task-pickup-format/status",
          payload: { status: "picked_up", expectedVersion: 1, pickupCode }
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid_courier_task_transition" });
      }
      expect(transition).not.toHaveBeenCalled();
    } finally {
      await api.close();
    }
  });

  it("updates tasks across every explicitly granted merchant tenant", async () => {
    const courier: Actor = {
      id: "courier-multi-tenant", role: "courier", active: true,
      grants: [
        { resource: "courier.delivery_task", actions: ["read", "update"], scope: { merchantId: "merchant-one" } },
        { resource: "courier.delivery_task", actions: ["read", "update"], scope: { merchantId: "merchant-two" } }
      ]
    };
    const transition = vi.fn(async (input: { tenantId: string }) => input.tenantId === "merchant-one"
      ? { outcome: "not_found" as const }
      : { outcome: "updated" as const, task: {
          id: "task-from-second-tenant", tenantId: "merchant-two", orderId: "order-2",
          suborderId: "suborder-2", courierId: courier.id, status: "accepted" as const,
          version: 2, updatedAtUtc: new Date().toISOString()
        } });
    const api = buildApp({ resolveActor: async () => courier, courierTasks: {
      listForCourier: vi.fn(async () => []), transition
    } });
    await api.ready();
    try {
      const response = await api.inject({
        method: "PATCH", url: "/api/v1/courier/tasks/task-from-second-tenant/status",
        payload: { status: "accepted", expectedVersion: 1 }
      });
      expect(response.statusCode).toBe(200);
      expect(transition).toHaveBeenNthCalledWith(1, expect.objectContaining({ tenantId: "merchant-one" }));
      expect(transition).toHaveBeenNthCalledWith(2, expect.objectContaining({ tenantId: "merchant-two" }));
      expect(response.json().task.tenantId).toBe("merchant-two");
    } finally {
      await api.close();
    }
  });

  it("does not accept a courier identifier from the request body", async () => {
    const courier: Actor = {
      id: "courier-principal-2", role: "courier", active: true,
      grants: [{
        resource: "courier.delivery_task", actions: ["update"],
        scope: { merchantId: "merchant-courier-2" }
      }]
    };
    const transition = vi.fn(async () => ({ outcome: "not_found" as const }));
    const api = buildApp({ resolveActor: async () => courier, courierTasks: {
      listForCourier: vi.fn(async () => []), transition
    } });
    await api.ready();
    try {
      const response = await api.inject({
        method: "PATCH", url: "/api/v1/courier/tasks/task-2/status",
        payload: { courierId: "attacker-id", status: "accepted", expectedVersion: 1 }
      });
      expect(response.statusCode).toBe(404);
      expect(transition).toHaveBeenCalledWith(expect.objectContaining({
        courierId: courier.id, tenantId: "merchant-courier-2"
      }));
    } finally {
      await api.close();
    }
  });
  it("issues and finalizes delivery-proof uploads only within the courier task scope", async () => {
    const courier: Actor = {
      id: "courier-proof-1", role: "courier", active: true,
      grants: [{ resource: "courier.delivery_task", actions: ["update"], scope: { merchantId: "merchant-proof-1" } }]
    };
    const requestProofUpload = vi.fn(async () => ({
      outcome: "upload_created" as const, uploadId: "upload_12345678",
      uploadUrl: "https://storage.example.invalid/signed-upload",
      expiresAtUtc: "2026-11-17T16:00:00.000Z"
    }));
    const finalizeProofUpload = vi.fn(async () => ({
      outcome: "verified" as const, evidenceId: "evidence-1",
      verifiedAtUtc: "2026-11-17T15:59:00.000Z"
    }));
    const api = buildApp({
      resolveActor: async () => courier,
      courierDeliveryEvidence: { requestProofUpload, finalizeProofUpload }
    });
    await api.ready();
    try {
      const created = await api.inject({
        method: "POST", url: "/api/v1/courier/tasks/task-proof/proof-upload",
        payload: { contentType: "image/jpeg", contentLength: 2048, contentSha256: "a".repeat(64) }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ uploadId: "upload_12345678", requiredHeaders: { "content-type": "image/jpeg" } });
      expect(requestProofUpload).toHaveBeenCalledWith({
        tenantId: "merchant-proof-1", taskId: "task-proof", courierId: courier.id,
        contentType: "image/jpeg", contentLength: 2048, contentSha256: "a".repeat(64)
      });

      const completed = await api.inject({
        method: "POST",
        url: "/api/v1/courier/tasks/task-proof/proof-upload/upload_12345678/complete"
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({ outcome: "verified", evidenceId: "evidence-1" });
      expect(finalizeProofUpload).toHaveBeenCalledWith({
        tenantId: "merchant-proof-1", taskId: "task-proof", courierId: courier.id,
        uploadId: "upload_12345678"
      });
    } finally {
      await api.close();
    }
  });

  it("rejects unsafe delivery-proof upload metadata before calling storage", async () => {
    const courier: Actor = {
      id: "courier-proof-2", role: "courier", active: true,
      grants: [{ resource: "courier.delivery_task", actions: ["update"], scope: { merchantId: "merchant-proof-2" } }]
    };
    const requestProofUpload = vi.fn();
    const api = buildApp({
      resolveActor: async () => courier,
      courierDeliveryEvidence: {
        requestProofUpload,
        finalizeProofUpload: vi.fn()
      }
    });
    await api.ready();
    try {
      const response = await api.inject({
        method: "POST", url: "/api/v1/courier/tasks/task-proof/proof-upload",
        payload: { contentType: "text/html", contentLength: 2048, contentSha256: "not-a-sha256" }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_delivery_proof_upload" });
      expect(requestProofUpload).not.toHaveBeenCalled();
    } finally {
      await api.close();
    }
  });

});


describe("courier dispatch offer responses", () => {
  const courierActor: Actor = {
    id: "courier-1", role: "courier", active: true,
    grants: [{
      resource: "courier.delivery_task", actions: ["read", "update"],
      scope: { merchantId: "tenant-1" }
    }]
  };

  it("routes a verified courier's offer decision through the transactional command", async () => {
    const respond = vi.fn(async () => ({ outcome: "accepted" as const, taskId: "task-1", offerVersion: 3 }));
    const courierApp = buildApp({
      resolveActor: async () => courierActor,
      courierDispatchOfferCommands: { respond }
    });
    await courierApp.ready();
    try {
      const response = await courierApp.inject({
        method: "POST", url: "/api/v1/courier/offers/offer-12345678/respond",
        payload: { decision: "accepted", expectedVersion: 2 }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ outcome: "accepted", taskId: "task-1", offerVersion: 3 });
      expect(respond).toHaveBeenCalledWith({
        tenantId: "tenant-1", offerId: "offer-12345678", courierId: "courier-1",
        expectedVersion: 2, decision: "accepted"
      });
    } finally { await courierApp.close(); }
  });

  it("rejects invalid decline requests before calling the command store", async () => {
    const respond = vi.fn();
    const courierApp = buildApp({
      resolveActor: async () => courierActor,
      courierDispatchOfferCommands: { respond }
    });
    await courierApp.ready();
    try {
      const response = await courierApp.inject({
        method: "POST", url: "/api/v1/courier/offers/offer-12345678/respond",
        payload: { decision: "declined", expectedVersion: 2, reason: " " }
      });
      expect(response.statusCode).toBe(400);
      expect(respond).not.toHaveBeenCalled();
    } finally { await courierApp.close(); }
  });

  it("does not allow non-couriers to respond to offers", async () => {
    const respond = vi.fn();
    const nonCourierApp = buildApp({
      resolveActor: async () => ({ ...courierActor, role: "customer" as const, grants: courierActor.grants }),
      courierDispatchOfferCommands: { respond }
    });
    await nonCourierApp.ready();
    try {
      const response = await nonCourierApp.inject({
        method: "POST", url: "/api/v1/courier/offers/offer-12345678/respond",
        payload: { decision: "accepted", expectedVersion: 2 }
      });
      expect(response.statusCode).toBe(403);
      expect(respond).not.toHaveBeenCalled();
    } finally { await nonCourierApp.close(); }
  });
});


describe("courier availability endpoint", () => {
  const courier: Actor = {
    id: "courier-availability-1", role: "courier", active: true,
    grants: [{
      resource: "courier.delivery_task", actions: ["update"],
      scope: { merchantId: "merchant-availability-1" }
    }]
  };

  it("updates the authenticated courier availability and heartbeat", async () => {
    const setAvailability = vi.fn(async (input: { courierId: string; available: boolean }) => ({
      outcome: "updated" as const, available: input.available, updatedAtUtc: "2026-11-19T10:00:00.000Z"
    }));
    const api = buildApp({ resolveActor: async () => courier, courierAvailability: { setAvailability } });
    await api.ready();
    try {
      const response = await api.inject({
        method: "PUT", url: "/api/v1/courier/availability", payload: { available: true }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        outcome: "updated", available: true, updatedAtUtc: "2026-11-19T10:00:00.000Z"
      });
      expect(setAvailability).toHaveBeenCalledWith({ courierId: courier.id, available: true });
    } finally { await api.close(); }
  });

  it("rejects malformed availability payloads", async () => {
    const setAvailability = vi.fn();
    const api = buildApp({ resolveActor: async () => courier, courierAvailability: { setAvailability } });
    await api.ready();
    try {
      const response = await api.inject({
        method: "PUT", url: "/api/v1/courier/availability",
        payload: { available: true, courierId: "attacker-controlled" }
      });
      expect(response.statusCode).toBe(400);
      expect(setAvailability).not.toHaveBeenCalled();
    } finally { await api.close(); }
  });

  it("does not allow a non-courier to change courier availability", async () => {
    const setAvailability = vi.fn();
    const api = buildApp({
      resolveActor: async () => ({ ...courier, role: "customer" as const }),
      courierAvailability: { setAvailability }
    });
    await api.ready();
    try {
      const response = await api.inject({
        method: "PUT", url: "/api/v1/courier/availability", payload: { available: true }
      });
      expect(response.statusCode).toBe(403);
      expect(setAvailability).not.toHaveBeenCalled();
    } finally { await api.close(); }
  });

  it("does not enable an unapproved courier", async () => {
    const setAvailability = vi.fn(async () => ({ outcome: "not_eligible" as const }));
    const api = buildApp({ resolveActor: async () => courier, courierAvailability: { setAvailability } });
    await api.ready();
    try {
      const response = await api.inject({
        method: "PUT", url: "/api/v1/courier/availability", payload: { available: true }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "courier_profile_not_eligible" });
    } finally { await api.close(); }
  });
});


describe("platform courier governance endpoints", () => {
  const admin: Actor = {
    id: "platform-admin-1", role: "platform_admin", active: true,
    grants: [{
      resource: "platform.courier_profile", actions: ["read", "create", "approve", "manage_access"],
      scope: { platform: true }
    }]
  };
  const auditEvents = { append: vi.fn(async () => "inserted" as const) };

  it("creates a pending courier profile only through a platform administrator", async () => {
    const createProfile = vi.fn(async () => "created" as const);
    const api = buildApp({
      resolveActor: async () => admin, auditEvents,
      courierAdminProfiles: {
        listVehicles: vi.fn(async () => []), listProfiles: vi.fn(async () => []), createProfile,
        reviewProfile: vi.fn(async () => "updated" as const),
        registerVehicle: vi.fn(async () => "created" as const),
        reviewVehicle: vi.fn(async () => "updated" as const),
        grantServiceArea: vi.fn(async () => "granted" as const),
        revokeServiceArea: vi.fn(async () => "revoked" as const)
      }
    });
    await api.ready();
    try {
      const response = await api.inject({
        method: "POST", url: "/api/v1/platform/couriers",
        payload: { courierId: "courier-new", maxConcurrentTasks: 2 }
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        outcome: "created", courierId: "courier-new", accountStatus: "pending", verificationStatus: "pending"
      });
      expect(createProfile).toHaveBeenCalledWith({ courierId: "courier-new", maxConcurrentTasks: 2 });
      expect(auditEvents.append).toHaveBeenCalled();
    } finally { await api.close(); }
  });

  it("denies merchant actors access to platform courier governance", async () => {
    const createProfile = vi.fn();
    const api = buildApp({
      resolveActor: async () => ({ ...admin, role: "merchant_owner" as const, grants: [] }),
      courierAdminProfiles: {
        listVehicles: vi.fn(async () => []), listProfiles: vi.fn(async () => []), createProfile,
        reviewProfile: vi.fn(async () => "updated" as const),
        registerVehicle: vi.fn(async () => "created" as const),
        reviewVehicle: vi.fn(async () => "updated" as const),
        grantServiceArea: vi.fn(async () => "granted" as const),
        revokeServiceArea: vi.fn(async () => "revoked" as const)
      }
    });
    await api.ready();
    try {
      const response = await api.inject({
        method: "POST", url: "/api/v1/platform/couriers",
        payload: { courierId: "courier-new" }
      });
      expect(response.statusCode).toBe(403);
      expect(createProfile).not.toHaveBeenCalled();
    } finally { await api.close(); }
  });

  it("registers a pending vehicle through the platform governance adapter", async () => {
    const registerVehicle = vi.fn(async () => "created" as const);
    const api = buildApp({
      resolveActor: async () => admin, auditEvents,
      courierAdminProfiles: {
        listVehicles: vi.fn(async () => []), listProfiles: vi.fn(async () => []), createProfile: vi.fn(async () => "created" as const),
        reviewProfile: vi.fn(async () => "updated" as const), registerVehicle,
        reviewVehicle: vi.fn(async () => "updated" as const),
        grantServiceArea: vi.fn(async () => "granted" as const),
        revokeServiceArea: vi.fn(async () => "revoked" as const)
      }
    });
    await api.ready();
    try {
      const response = await api.inject({
        method: "POST", url: "/api/v1/platform/courier-vehicles",
        payload: { courierId: "courier-1", vehicleType: "car", capacityWeightGrams: 100000, capacityVolumeLiters: 500 }
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ outcome: "created", verificationStatus: "pending", active: false });
      expect(registerVehicle).toHaveBeenCalledWith(expect.objectContaining({
        courierId: "courier-1", vehicleType: "car", capacityWeightGrams: 100000, capacityVolumeLiters: 500
      }));
    } finally { await api.close(); }
  });
  it("lists courier vehicles only for a platform administrator", async () => {
    const listVehicles = vi.fn(async () => [{
      vehicleId: "vehicle-1", courierId: "courier-1", vehicleType: "car" as const,
      verificationStatus: "pending" as const, capacityWeightGrams: 50000, capacityVolumeLiters: 200,
      active: false, createdAtUtc: "2026-11-22T00:00:00.000Z", updatedAtUtc: "2026-11-22T00:00:00.000Z"
    }]);
    const api = buildApp({
      resolveActor: async () => admin, auditEvents,
      courierAdminProfiles: {
        listVehicles, listProfiles: vi.fn(async () => []), createProfile: vi.fn(async () => "created" as const),
        reviewProfile: vi.fn(async () => "updated" as const), registerVehicle: vi.fn(async () => "created" as const),
        reviewVehicle: vi.fn(async () => "updated" as const), grantServiceArea: vi.fn(async () => "granted" as const),
        revokeServiceArea: vi.fn(async () => "revoked" as const)
      }
    });
    await api.ready();
    try {
      const response = await api.inject({ method: "GET", url: "/api/v1/platform/courier-vehicles?status=pending&limit=25" });
      expect(response.statusCode).toBe(200);
      expect(response.json().vehicles).toHaveLength(1);
      expect(listVehicles).toHaveBeenCalledWith({ status: "pending", limit: 25 });
    } finally { await api.close(); }
  });

});

describe("merchant courier pickup-code issuance API", () => {
  const owner: Actor = {
    id: "merchant-owner-issuer", role: "merchant_owner", active: true,
    grants: [{
      resource: "merchant.order", actions: ["update"],
      scope: { merchantId: "merchant-1", branchId: "branch-1", orderId: "order-1" }
    }]
  };

  it("returns the one-time code only after exact merchant order authorization and issuer success", async () => {
    const issue = vi.fn(async () => ({
      outcome: "issued" as const, code: "00427193", expiresAtUtc: "2026-11-22T05:15:00.000Z"
    }));
    const api = buildApp({
      resolveActor: async () => owner,
      resolveMerchantTenantId: async merchantId => merchantId === "merchant-1" ? "tenant-1" : null,
      courierPickupCodeIssuer: { issue }
    });
    await api.ready();
    try {
      const response = await api.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/branches/branch-1/orders/order-1/suborders/suborder-1/pickup-code",
        payload: { taskId: "task-1" }
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        outcome: "issued", code: "00427193", expiresAtUtc: "2026-11-22T05:15:00.000Z"
      });
      expect(issue).toHaveBeenCalledWith({
        tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1",
        orderId: "order-1", suborderId: "suborder-1", taskId: "task-1",
        actorId: owner.id, actorRole: "merchant_owner"
      });
    } finally { await api.close(); }
  });

  it("returns 429 with a retry hint when pickup-code issuance is throttled", async () => {
    const issue = vi.fn(async () => ({ outcome: "rate_limited" as const }));
    const api = buildApp({
      resolveActor: async () => owner,
      resolveMerchantTenantId: async () => "tenant-1",
      courierPickupCodeIssuer: { issue }
    });
    await api.ready();
    try {
      const response = await api.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/branches/branch-1/orders/order-1/suborders/suborder-1/pickup-code",
        payload: { taskId: "task-1" }
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("900");
      expect(response.json()).toEqual({
        error: "pickup_code_issuance_rate_limited", retryAfterSeconds: 900
      });
    } finally { await api.close(); }
  });

  it("denies cross-branch requests before calling the pickup-code issuer", async () => {
    const issue = vi.fn();
    const api = buildApp({
      resolveActor: async () => owner,
      resolveMerchantTenantId: async () => "tenant-1",
      courierPickupCodeIssuer: { issue }
    });
    await api.ready();
    try {
      const response = await api.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/branches/branch-2/orders/order-1/suborders/suborder-1/pickup-code",
        payload: { taskId: "task-1" }
      });
      expect(response.statusCode).toBe(403);
      expect(issue).not.toHaveBeenCalled();
    } finally { await api.close(); }
  });

  it("rejects courier actors and malformed task identifiers", async () => {
    const courier: Actor = {
      id: "courier-1", role: "courier", active: true,
      grants: [{
        resource: "merchant.order", actions: ["update"],
        scope: { merchantId: "merchant-1", branchId: "branch-1", orderId: "order-1" }
      }]
    };
    const issue = vi.fn();
    const api = buildApp({
      resolveActor: async () => courier,
      resolveMerchantTenantId: async () => "tenant-1",
      courierPickupCodeIssuer: { issue }
    });
    await api.ready();
    try {
      const denied = await api.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/branches/branch-1/orders/order-1/suborders/suborder-1/pickup-code",
        payload: { taskId: "task-1" }
      });
      expect(denied.statusCode).toBe(403);
      expect(issue).not.toHaveBeenCalled();
    } finally { await api.close(); }

    const employee: Actor = {
      ...owner, role: "merchant_employee"
    };
    const employeeApi = buildApp({
      resolveActor: async () => employee,
      resolveMerchantTenantId: async () => "tenant-1",
      courierPickupCodeIssuer: { issue }
    });
    await employeeApi.ready();
    try {
      const malformed = await employeeApi.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/branches/branch-1/orders/order-1/suborders/suborder-1/pickup-code",
        payload: { taskId: "bad id", plaintextCode: "client-controlled" }
      });
      expect(malformed.statusCode).toBe(400);
      expect(issue).not.toHaveBeenCalled();
    } finally { await employeeApi.close(); }
  });
});
