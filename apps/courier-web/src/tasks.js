const ACTIVE_STATUSES = new Set([
  "accepted", "heading_to_pickup", "arrived_at_pickup",
  "picked_up", "in_transit", "arrived_at_dropoff", "in_progress"
]);
const HISTORY_STATUSES = new Set(["delivered", "completed", "declined", "cancelled", "failed"]);

const NEXT_ACTIONS = Object.freeze({
  accepted: { status: "heading_to_pickup", label: "toStore" },
  heading_to_pickup: { status: "arrived_at_pickup", label: "atStore" },
  arrived_at_pickup: { status: "picked_up", label: "collect", requiresPickupCode: true },
  picked_up: { status: "in_transit", label: "toCustomer" },
  in_transit: { status: "arrived_at_dropoff", label: "atCustomer" }
});

export function acceptTask(tasks, taskId) {
  let found = false;
  const next = tasks.map((task) => {
    if (task.id !== taskId || task.status !== "offered") return task;
    found = true;
    return { ...task, status: "accepted" };
  });
  return { tasks: next, changed: found };
}

export function declineTask(tasks, taskId) {
  let found = false;
  const next = tasks.map((task) => {
    if (task.id !== taskId || task.status !== "offered") return task;
    found = true;
    return { ...task, status: "declined" };
  });
  return { tasks: next, changed: found };
}

export function getTaskGroups(tasks) {
  return {
    offers: tasks.filter((task) => task.status === "offered"),
    active: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)),
    history: tasks.filter((task) => HISTORY_STATUSES.has(task.status))
  };
}

export function getNextTaskAction(task) {
  if (!task || typeof task.status !== "string") return null;
  return NEXT_ACTIONS[task.status] ?? null;
}
