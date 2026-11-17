import test from "node:test";
import assert from "node:assert/strict";
import { acceptTask, declineTask, getTaskGroups } from "../src/tasks.js";

const tasks = [
  { id: "A", status: "offered" },
  { id: "B", status: "accepted" },
  { id: "C", status: "completed" }
];

test("accepts an offered task exactly once", () => {
  const result = acceptTask(tasks, "A");
  assert.equal(result.changed, true);
  assert.equal(result.tasks[0].status, "accepted");
  assert.equal(acceptTask(result.tasks, "A").changed, false);
});

test("does not accept a task that is not offered", () => {
  assert.equal(acceptTask(tasks, "B").changed, false);
  assert.equal(acceptTask(tasks, "missing").changed, false);
});

test("declines only an offered task", () => {
  const result = declineTask(tasks, "A");
  assert.equal(result.changed, true);
  assert.equal(result.tasks[0].status, "declined");
  assert.equal(declineTask(result.tasks, "A").changed, false);
});

test("groups every durable courier lifecycle status correctly", () => {
  const lifecycle = [
    ["offer", "offered", "offers"],
    ["accepted", "accepted", "active"],
    ["heading", "heading_to_pickup", "active"],
    ["at-pickup", "arrived_at_pickup", "active"],
    ["picked-up", "picked_up", "active"],
    ["transit", "in_transit", "active"],
    ["at-dropoff", "arrived_at_dropoff", "active"],
    ["delivered", "delivered", "history"],
    ["declined", "declined", "history"],
    ["cancelled", "cancelled", "history"],
    ["failed", "failed", "history"]
  ].map(([id, status]) => ({ id, status }));
  const groups = getTaskGroups(lifecycle);
  assert.deepEqual(groups.offers.map((task) => task.id), ["offer"]);
  assert.deepEqual(groups.active.map((task) => task.id), [
    "accepted", "heading", "at-pickup", "picked-up", "transit", "at-dropoff"
  ]);
  assert.deepEqual(groups.history.map((task) => task.id), [
    "delivered", "declined", "cancelled", "failed"
  ]);
});

test("retains compatibility with legacy UI statuses", () => {
  const groups = getTaskGroups([
    { id: "active", status: "in_progress" },
    { id: "done", status: "completed" }
  ]);
  assert.deepEqual(groups.active.map((task) => task.id), ["active"]);
  assert.deepEqual(groups.history.map((task) => task.id), ["done"]);
});
