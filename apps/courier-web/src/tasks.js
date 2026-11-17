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
    active: tasks.filter((task) => ["accepted", "in_progress"].includes(task.status)),
    history: tasks.filter((task) => ["completed", "declined"].includes(task.status))
  };
}
