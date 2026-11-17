import test from "node:test";
import assert from "node:assert/strict";
import { acceptTask, declineTask, getTaskGroups, getNextTaskAction } from "../src/tasks.js";

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
    ["offer", "offered"], ["accepted", "accepted"],
    ["heading", "heading_to_pickup"], ["at-pickup", "arrived_at_pickup"],
    ["picked-up", "picked_up"], ["transit", "in_transit"],
    ["at-dropoff", "arrived_at_dropoff"], ["delivered", "delivered"],
    ["declined", "declined"], ["cancelled", "cancelled"], ["failed", "failed"]
  ].map(([id, status]) => ({ id, status }));
  const groups = getTaskGroups(lifecycle);
  assert.deepEqual(groups.offers.map(task => task.id), ["offer"]);
  assert.deepEqual(groups.active.map(task => task.id), [
    "accepted", "heading", "at-pickup", "picked-up", "transit", "at-dropoff"
  ]);
  assert.deepEqual(groups.history.map(task => task.id), ["delivered", "declined", "cancelled", "failed"]);
});

test("maps only evidence-safe next actions", () => {
  assert.deepEqual(getNextTaskAction({ status: "accepted" }), {
    status: "heading_to_pickup", label: "toStore"
  });
  assert.deepEqual(getNextTaskAction({ status: "arrived_at_pickup" }), {
    status: "picked_up", label: "collect", requiresPickupCode: true
  });
  assert.equal(getNextTaskAction({ status: "arrived_at_dropoff" }), null);
  assert.equal(getNextTaskAction({ status: "delivered" }), null);
});

test("retains compatibility with legacy UI statuses", () => {
  const groups = getTaskGroups([
    { id: "active", status: "in_progress" },
    { id: "done", status: "completed" }
  ]);
  assert.deepEqual(groups.active.map(task => task.id), ["active"]);
  assert.deepEqual(groups.history.map(task => task.id), ["done"]);
});
