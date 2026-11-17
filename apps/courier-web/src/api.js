const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{32,256}$/;

export class CourierApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "CourierApiError";
    this.status = status;
    this.payload = payload;
  }
}

/**
 * Authenticated courier API client.
 * The opaque session token is held only by this instance and is never persisted.
 */
export function createCourierApi({ baseUrl = "", token, fetchImpl = globalThis.fetch }) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new TypeError("invalid_courier_session_token");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch_unavailable");

  const root = String(baseUrl).replace(/\/+$/, "");

  async function request(path, init = {}) {
    const response = await fetchImpl(`${root}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers
      }
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON error body */ }
    if (!response.ok) {
      throw new CourierApiError(
        typeof payload?.error === "string" ? payload.error : "courier_api_request_failed",
        response.status,
        payload
      );
    }
    return payload;
  }

  return Object.freeze({
    async listTasks() {
      const payload = await request("/api/v1/courier/tasks");
      if (!payload || !Array.isArray(payload.tasks)) {
        throw new CourierApiError("invalid_courier_tasks_response", 502, payload);
      }
      return payload.tasks;
    },
    async transitionTask(taskId, { status, expectedVersion, pickupCode, reason } = {}) {
      if (typeof taskId !== "string" || !taskId.trim()) throw new TypeError("invalid_task_id");
      if (typeof status !== "string" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        throw new TypeError("invalid_task_transition");
      }
      return request(`/api/v1/courier/tasks/${encodeURIComponent(taskId)}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          status,
          expectedVersion,
          ...(pickupCode === undefined ? {} : { pickupCode }),
          ...(reason === undefined ? {} : { reason })
        })
      });
    }
  });
}
