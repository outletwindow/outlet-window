import test from "node:test";
import assert from "node:assert/strict";
import { createAdminApi, AdminApiError } from "./api.js";

const token = `admin_session.${"x".repeat(40)}`;
const response = (payload, ok = true, status = 200) => ({ ok, status, json: async () => payload });

test("requires a well-formed session token and secure API URL", () => {
  assert.throws(() => createAdminApi({ token: "bad" }), /invalid_admin_session_token/);
  assert.throws(() => createAdminApi({ token, baseUrl: "http://example.com" }), /admin_api_requires_https/);
  assert.doesNotThrow(() => createAdminApi({ token, baseUrl: "http://localhost:3000" }));
});

test("lists profiles using platform route and bearer token without persistence", async () => {
  let request;
  const api = createAdminApi({ token, fetchImpl: async (url, init) => {
    request = { url, init };
    return response({ profiles: [{ courierId:"courier-1", accountStatus:"pending", verificationStatus:"pending",
      maxConcurrentTasks:1, updatedAtUtc:"2026-01-01T00:00:00.000Z" }] });
  }});
  const profiles = await api.listProfiles("pending");
  assert.equal(profiles.length, 1);
  assert.match(request.url, /status=pending/);
  assert.equal(request.init.headers.authorization, `Bearer ${token}`);
  assert.equal(request.init.method, undefined);
});

test("creates profile and rejects malformed API profile data", async () => {
  let body;
  const api = createAdminApi({ token, fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return response({ outcome:"created" }, true, 201); } });
  await api.createProfile({ courierId:"courier-2", maxConcurrentTasks:3 });
  assert.deepEqual(body, { courierId:"courier-2", maxConcurrentTasks:3 });
  const bad = createAdminApi({ token, fetchImpl: async () => response({ profiles:[{ courierId:"x", accountStatus:"unknown" }] }) });
  await assert.rejects(() => bad.listProfiles(), error => error instanceof AdminApiError && error.status === 502);
});

test("reviews profiles, registers and reviews vehicles, and grants service access", async () => {
  const calls = [];
  const api = createAdminApi({ token, fetchImpl: async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return response({ outcome:"updated", vehicleId:"vehicle-1" }, true, 200);
  }});
  await api.reviewProfile("courier-1", "approve");
  await api.registerVehicle({ courierId:"courier-1", vehicleType:"car", capacityWeightGrams:50000, capacityVolumeLiters:200 });
  await api.reviewVehicle("vehicle-1", "approve");
  await api.setServiceArea({ courierId:"courier-1", tenantId:"tenant-1", serviceAreaId:"area-1", action:"grant" });
  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /couriers\/courier-1\/review$/);
  assert.match(calls[3].url, /memberships\/grant$/);
});

test("rejects unsafe identifiers and invalid decisions", async () => {
  const api = createAdminApi({ token, fetchImpl: async () => response({}) });
  await assert.rejects(() => api.reviewProfile("../other", "approve"), /invalid_courier_review/);
  await assert.rejects(() => api.reviewVehicle("vehicle-1", "suspend"), /invalid_vehicle_review/);
  await assert.rejects(() => api.setServiceArea({ courierId:"c", tenantId:"t", serviceAreaId:"a", action:"delete" }), /invalid_courier_service_area/);
});

test("surfaces API authorization errors without leaking the token", async () => {
  const api = createAdminApi({ token, fetchImpl: async () => response({ error:"platform_admin_only" }, false, 403) });
  await assert.rejects(() => api.listProfiles(), error => error instanceof AdminApiError && error.status === 403 && error.message === "platform_admin_only");
});

test("lists pending vehicles from the platform administration endpoint", async () => {
  let request;
  const api = createAdminApi({ token, fetchImpl: async (url, init) => {
    request = { url, init };
    return response({ vehicles: [{
      vehicleId: "vehicle-1", courierId: "courier-1", vehicleType: "car",
      verificationStatus: "pending", capacityWeightGrams: 50000, capacityVolumeLiters: 200, active: false
    }] });
  }});
  const vehicles = await api.listVehicles("pending");
  assert.equal(vehicles.length, 1);
  assert.match(request.url, /courier-vehicles\\?limit=200&status=pending/);
  assert.equal(request.init.headers.authorization, `Bearer ${token}`);
});
