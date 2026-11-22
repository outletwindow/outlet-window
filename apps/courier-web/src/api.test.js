import test from "node:test";
import assert from "node:assert/strict";
import { createCourierApi, CourierApiError } from "./api.js";

const token = `courier_session.${"x".repeat(40)}`;
const response = (payload, ok = true, status = 200) => ({
  ok, status, json: async () => payload
});

test("requires a well-formed session token and HTTPS API URL", () => {
  assert.throws(() => createCourierApi({ token: "bad" }), /invalid_courier_session_token/);
  assert.throws(() => createCourierApi({ token, baseUrl: "http://example.com" }), /courier_api_requires_https/);
  assert.doesNotThrow(() => createCourierApi({ token, baseUrl: "http://localhost:3000" }));
});

test("sets availability with the authenticated session and validates the response", async () => {
  let request;
  const api = createCourierApi({ token, fetchImpl: async (url, init) => {
    request = { url, init };
    return response({ outcome: "updated", available: true, updatedAtUtc: "2026-11-22T05:00:00.000Z" });
  }});
  const result = await api.setAvailability(true);
  assert.equal(result.available, true);
  assert.equal(request.url, "/api/v1/courier/availability");
  assert.equal(request.init.method, "PUT");
  assert.equal(request.init.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(request.init.body), { available: true });
  await assert.rejects(() => api.setAvailability("yes"), /invalid_courier_availability/);
});

test("lists offers and rejects malformed offer records", async () => {
  const offer = {
    id: "offer-1", suborderId: "suborder-1", status: "offered", version: 2,
    offeredAtUtc: "2026-11-22T05:00:00.000Z", expiresAtUtc: "2026-11-22T05:05:00.000Z"
  };
  const api = createCourierApi({ token, fetchImpl: async () => response({ offers: [offer] }) });
  assert.deepEqual(await api.listOffers(), [offer]);
  const malformed = createCourierApi({ token, fetchImpl: async () => response({ offers: [{ ...offer, version: 0 }] }) });
  await assert.rejects(() => malformed.listOffers(), error =>
    error instanceof CourierApiError && error.status === 502 && error.message === "invalid_courier_offers_response");
});

test("responds to an offer with optimistic version and required decline reason", async () => {
  let request;
  const api = createCourierApi({ token, fetchImpl: async (url, init) => {
    request = { url, init };
    return response({ outcome: "accepted", taskId: "task-1", offerVersion: 3 });
  }});
  await api.respondToOffer("offer-1", { decision: "accepted", expectedVersion: 2 });
  assert.equal(request.url, "/api/v1/courier/offers/offer-1/respond");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(request.init.body), { decision: "accepted", expectedVersion: 2 });
  await assert.rejects(() => api.respondToOffer("offer-1", { decision: "declined", expectedVersion: 2 }), /invalid_courier_dispatch_offer_response/);
});

test("sends pickup verification and expected task version without persisting session data", async () => {
  let request;
  const api = createCourierApi({ token, fetchImpl: async (url, init) => {
    request = { url, init };
    return response({ task: { id: "task-1", status: "picked_up", version: 4 } });
  }});
  await api.transitionTask("task-1", { status: "picked_up", expectedVersion: 3, pickupCode: "482913" });
  assert.equal(request.url, "/api/v1/courier/tasks/task-1/status");
  assert.equal(request.init.method, "PATCH");
  assert.deepEqual(JSON.parse(request.init.body), {
    status: "picked_up", expectedVersion: 3, pickupCode: "482913"
  });
  assert.equal(request.init.headers.authorization, `Bearer ${token}`);
});

test("rejects delivery proof files outside the supported size and media constraints", async () => {
  const api = createCourierApi({ token, fetchImpl: async () => response({}) });
  await assert.rejects(() => api.uploadDeliveryProof("task-1", {
    type: "application/pdf", size: 100, arrayBuffer: async () => new ArrayBuffer(100)
  }), /invalid_delivery_proof_file/);
  await assert.rejects(() => api.uploadDeliveryProof("task-1", {
    type: "image/jpeg", size: 10 * 1024 * 1024 + 1, arrayBuffer: async () => new ArrayBuffer(1)
  }), /invalid_delivery_proof_file/);
});
