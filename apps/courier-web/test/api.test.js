import test from "node:test";
import assert from "node:assert/strict";
import { createCourierApi, CourierApiError } from "../src/api.js";

const token = ["session-id", "x".repeat(40)].join(".");
const response = (status, payload) => ({
  ok: status >= 200 && status < 300, status, async json() { return payload; }
});

test("rejects malformed session token", () => {
  assert.throws(() => createCourierApi({ token: "bad", fetchImpl() {} }), TypeError);
});

test("lists authenticated tasks", async () => {
  let request;
  const api = createCourierApi({
    baseUrl: "https://api.example.test/", token,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response(200, { tasks: [{ id: "task-1", status: "offered" }] });
    }
  });
  assert.equal((await api.listTasks()).length, 1);
  assert.equal(request.url, "https://api.example.test/api/v1/courier/tasks");
  assert.equal(request.init.headers.authorization, "Bearer " + token);
});

test("sends optimistic task transition and pickup code", async () => {
  let request;
  const api = createCourierApi({
    token,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response(200, { task: { id: "task-1", status: "picked_up", version: 4 } });
    }
  });
  await api.transitionTask("task-1", { status: "picked_up", expectedVersion: 3, pickupCode: "code" });
  assert.equal(request.init.method, "PATCH");
  assert.deepEqual(JSON.parse(request.init.body), {
    status: "picked_up", expectedVersion: 3, pickupCode: "code"
  });
});

test("preserves API conflict status", async () => {
  const api = createCourierApi({
    token, fetchImpl: async () => response(409, { error: "courier_task_version_conflict" })
  });
  await assert.rejects(api.listTasks(), error =>
    error instanceof CourierApiError && error.status === 409
  );
});

test("uploads delivery proof, then finalizes server verification", async () => {
  const requests = [];
  const fileBytes = new Uint8Array([1, 2, 3, 4]);
  const file = {
    type: "image/jpeg",
    size: fileBytes.byteLength,
    async arrayBuffer() { return fileBytes.buffer; }
  };
  const api = createCourierApi({
    token,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) return response(201, {
        uploadId: "upload_12345678",
        uploadUrl: "https://objects.example.test/signed-upload",
        requiredHeaders: { "content-type": "image/jpeg", "if-none-match": "*" }
      });
      if (requests.length === 2) return response(200, null);
      return response(200, { outcome: "verified", evidenceId: "evidence-1" });
    }
  });
  const result = await api.uploadDeliveryProof("task/1", file);
  assert.deepEqual(result, { outcome: "verified", evidenceId: "evidence-1" });
  assert.equal(requests[0].url, "/api/v1/courier/tasks/task%2F1/proof-upload");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[1].url, "https://objects.example.test/signed-upload");
  assert.equal(requests[1].init.method, "PUT");
  assert.equal(requests[1].init.headers["if-none-match"], "*");
  assert.equal(requests[2].url, "/api/v1/courier/tasks/task%2F1/proof-upload/upload_12345678/complete");
});

test("does not follow redirects for signed proof uploads", async () => {
  const requests = [];
  const file = {
    type: "image/png", size: 3,
    async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; }
  };
  const api = createCourierApi({
    token,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) return response(201, {
        uploadId: "upload_12345678",
        uploadUrl: "https://objects.example.test/signed",
        requiredHeaders: { "content-type": "image/png", "if-none-match": "*" }
      });
      if (requests.length === 2) throw new TypeError("redirect blocked");
      return response(200, {});
    }
  });
  await assert.rejects(api.uploadDeliveryProof("task-1", file), /redirect blocked/);
  assert.equal(requests[1].init.redirect, "error");
  assert.equal(requests.length, 2);
});

test("rejects unexpected signed upload headers before sending file bytes", async () => {
  let uploadAttempted = false;
  const file = {
    type: "image/png", size: 3,
    async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; }
  };
  const api = createCourierApi({
    token,
    fetchImpl: async (_url, init) => {
      if (init.method === "POST") return response(201, {
        uploadId: "upload_12345678",
        uploadUrl: "https://objects.example.test/signed",
        requiredHeaders: {
          "content-type": "image/png", "if-none-match": "*", authorization: "Bearer leaked"
        }
      });
      uploadAttempted = true;
      return response(200, {});
    }
  });
  await assert.rejects(api.uploadDeliveryProof("task-1", file), /invalid_delivery_proof_upload_headers/);
  assert.equal(uploadAttempted, false);
});

test("rejects unsupported delivery proof files before making requests", async () => {
  let called = false;
  const api = createCourierApi({ token, fetchImpl: async () => { called = true; return response(200, {}); } });
  await assert.rejects(api.uploadDeliveryProof("task-1", {
    type: "text/html", size: 10, async arrayBuffer() { return new ArrayBuffer(10); }
  }), /invalid_delivery_proof_file/);
  assert.equal(called, false);
});

test("rejects insecure or credential-bearing API endpoints", () => {
  assert.throws(() => createCourierApi({ baseUrl: "http://api.example.test", token }), /courier_api_requires_https/);
  assert.throws(() => createCourierApi({ baseUrl: "https://user:pass@example.test", token }), /invalid_courier_api_base_url/);
});

test("allows local HTTP development endpoint", () => {
  assert.doesNotThrow(() => createCourierApi({ baseUrl: "http://localhost:3000", token }));
});
