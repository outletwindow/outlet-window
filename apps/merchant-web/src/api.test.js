import test from "node:test";
import assert from "node:assert/strict";
import { createMerchantApi, MerchantApiError } from "./api.js";

const token = "merchant01." + "x".repeat(40);
const scope = {
  merchantId: "merchant-1", branchId: "branch-1", orderId: "order-1",
  suborderId: "suborder-1", taskId: "task-1"
};

test("issues a code through the exact merchant branch and order scope", async () => {
  let request;
  const api = createMerchantApi({
    baseUrl: "https://api.example.com/",
    token,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, status: 201, json: async () => ({
        outcome: "issued", code: "00123456", expiresAtUtc: "2026-11-22T05:15:00.000Z"
      }) };
    }
  });
  const result = await api.issuePickupCode(scope);
  assert.deepEqual(result, { code: "00123456", expiresAtUtc: "2026-11-22T05:15:00.000Z" });
  assert.equal(request.url, "https://api.example.com/api/v1/merchants/merchant-1/branches/branch-1/orders/order-1/suborders/suborder-1/pickup-code");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(request.init.body), { taskId: "task-1" });
});

test("rejects malformed identifiers before sending a request", async () => {
  let calls = 0;
  const api = createMerchantApi({ token, fetchImpl: async () => { calls++; } });
  await assert.rejects(api.issuePickupCode({ ...scope, taskId: "bad task" }), /invalid_pickup_code_scope/);
  assert.equal(calls, 0);
});

test("requires HTTPS outside localhost", () => {
  assert.throws(() => createMerchantApi({ baseUrl: "http://api.example.com", token }), /requires_https/);
  assert.doesNotThrow(() => createMerchantApi({ baseUrl: "http://localhost:3000", token }));
});

test("rejects a malformed successful API response instead of showing an untrusted code", async () => {
  const api = createMerchantApi({
    token,
    fetchImpl: async () => ({ ok: true, status: 201, json: async () => ({
      outcome: "issued", code: "123", expiresAtUtc: "not-a-date"
    }) })
  });
  await assert.rejects(api.issuePickupCode(scope), error =>
    error instanceof MerchantApiError && error.status === 502 &&
    error.message === "invalid_pickup_code_response"
  );
});

test("surfaces server-side authorization and readiness errors", async () => {
  const api = createMerchantApi({
    token,
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: "forbidden" }) })
  });
  await assert.rejects(api.issuePickupCode(scope), error =>
    error instanceof MerchantApiError && error.status === 403 && error.message === "forbidden"
  );
});

test("loads real merchant branch orders with bearer authorization and validates scope", async () => {
  let request;
  const api = createMerchantApi({
    baseUrl: "https://api.example.com",
    token,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, status: 200, json: async () => ({ orders: [{
        orderId: "order-1", suborderId: "suborder-1", merchantId: "merchant-1",
        branchId: "branch-1", orderStatus: "confirmed", suborderStatus: "ready_for_pickup",
        subtotalMinor: 12500, currency: "SAR", itemCount: 2,
        createdAtUtc: "2026-11-22T06:00:00.000Z",
        task: { id: "task-1", status: "arrived_at_pickup", version: 3 }
      }] }) };
    }
  });
  const orders = await api.listOrders({ merchantId: "merchant-1", branchId: "branch-1", status: "ready_for_pickup", limit: 25 });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].task.id, "task-1");
  assert.equal(request.url, "https://api.example.com/api/v1/merchants/merchant-1/branches/branch-1/orders?limit=25&status=ready_for_pickup");
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.headers.authorization, `Bearer ${token}`);
});

test("rejects merchant order payloads that escape the requested branch", async () => {
  const api = createMerchantApi({
    token,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ orders: [{
      orderId: "order-1", suborderId: "suborder-1", merchantId: "merchant-1",
      branchId: "other-branch", suborderStatus: "ready_for_pickup",
      subtotalMinor: 1, itemCount: 1, createdAtUtc: "2026-11-22T06:00:00.000Z", task: null
    }] }) })
  });
  await assert.rejects(api.listOrders({ merchantId: "merchant-1", branchId: "branch-1" }),
    error => error instanceof MerchantApiError && error.message === "invalid_merchant_orders_response");
});
