const ACTIVE_STATUSES = new Set([
  "accepted", "heading_to_pickup", "arrived_at_pickup",
  "picked_up", "in_transit", "arrived_at_dropoff", "in_progress"
]);
const HISTORY_STATUSES = new Set(["delivered", "completed", "declined", "cancelled", "failed"]);

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
