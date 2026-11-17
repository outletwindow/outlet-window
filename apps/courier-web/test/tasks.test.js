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

test("groups tasks into offers, active work and history", () => {
  const groups = getTaskGroups(tasks);
  assert.deepEqual(groups.offers.map((task) => task.id), ["A"]);
  assert.deepEqual(groups.active.map((task) => task.id), ["B"]);
  assert.deepEqual(groups.history.map((task) => task.id), ["C"]);
});
