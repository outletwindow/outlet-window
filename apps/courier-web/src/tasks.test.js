import test from "node:test";
import assert from "node:assert/strict";
import { getNextTaskAction, getTaskGroups } from "./tasks.js";

test("groups active, offered, and terminal courier tasks without overlap", () => {
  const tasks = [
    { id: "a", status: "offered" },
    { id: "b", status: "accepted" },
    { id: "c", status: "in_transit" },
    { id: "d", status: "delivered" },
    { id: "e", status: "failed" }
  ];
  const groups = getTaskGroups(tasks);
  assert.deepEqual(groups.offers.map(task => task.id), ["a"]);
  assert.deepEqual(groups.active.map(task => task.id), ["b", "c"]);
  assert.deepEqual(groups.history.map(task => task.id), ["d", "e"]);
});

test("exposes only the next valid action for each non-terminal task status", () => {
  assert.deepEqual(getNextTaskAction({ status: "accepted" }), {
    status: "heading_to_pickup", label: "toStore"
  });
  assert.deepEqual(getNextTaskAction({ status: "heading_to_pickup" }), {
    status: "arrived_at_pickup", label: "atStore"
  });
  assert.deepEqual(getNextTaskAction({ status: "arrived_at_pickup" }), {
    status: "picked_up", label: "collect", requiresPickupCode: true
  });
  assert.deepEqual(getNextTaskAction({ status: "picked_up" }), {
    status: "in_transit", label: "toCustomer"
  });
  assert.deepEqual(getNextTaskAction({ status: "in_transit" }), {
    status: "arrived_at_dropoff", label: "atCustomer"
  });
  for (const status of ["offered", "arrived_at_dropoff", "delivered", "declined", "cancelled", "failed"]) {
    assert.equal(getNextTaskAction({ status }), null);
  }
  assert.equal(getNextTaskAction(null), null);
});
