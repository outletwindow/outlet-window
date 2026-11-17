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
