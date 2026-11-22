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
