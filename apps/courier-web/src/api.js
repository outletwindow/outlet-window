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

  const configuredBase = String(baseUrl).trim();
  if (configuredBase) {
    let parsed;
    try { parsed = new URL(configuredBase); } catch { throw new TypeError("invalid_courier_api_base_url"); }
    const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !localHttp) throw new TypeError("courier_api_requires_https");
    if (parsed.username || parsed.password) throw new TypeError("invalid_courier_api_base_url");
  }
  const root = configuredBase.replace(/\/+$/, "");

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
    async setAvailability(available) {
      if (typeof available !== "boolean") throw new TypeError("invalid_courier_availability");
      const payload = await request("/api/v1/courier/availability", {
        method: "PUT", body: JSON.stringify({ available })
      });
      if (!payload || payload.outcome !== "updated" || payload.available !== available ||
          typeof payload.updatedAtUtc !== "string" || !Number.isFinite(Date.parse(payload.updatedAtUtc))) {
        throw new CourierApiError("invalid_courier_availability_response", 502, payload);
      }
      return payload;
    },
    async listTasks() {
      const payload = await request("/api/v1/courier/tasks");
      if (!payload || !Array.isArray(payload.tasks)) {
        throw new CourierApiError("invalid_courier_tasks_response", 502, payload);
      }
      return payload.tasks;
    },
    async listOffers() {
      const payload = await request("/api/v1/courier/offers");
      if (!payload || !Array.isArray(payload.offers) || payload.offers.some(offer =>
        !offer || typeof offer.id !== "string" || typeof offer.suborderId !== "string" ||
        offer.status !== "offered" || !Number.isSafeInteger(offer.version) ||
        typeof offer.offeredAtUtc !== "string" || !Number.isFinite(Date.parse(offer.offeredAtUtc)) ||
        typeof offer.expiresAtUtc !== "string" || !Number.isFinite(Date.parse(offer.expiresAtUtc))
      )) {
        throw new CourierApiError("invalid_courier_offers_response", 502, payload);
      }
      return payload.offers;
    },
    async respondToOffer(offerId, { decision, expectedVersion, reason } = {}) {
      if (typeof offerId !== "string" || !offerId.trim() ||
          !["accepted", "declined"].includes(decision) ||
          !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
          (decision === "declined" && (typeof reason !== "string" || !reason.trim() || reason.length > 500)) ||
          (decision === "accepted" && reason !== undefined)) {
        throw new TypeError("invalid_courier_dispatch_offer_response");
      }
      return request(`/api/v1/courier/offers/${encodeURIComponent(offerId)}/respond`, {
        method: "POST",
        body: JSON.stringify({
          decision, expectedVersion,
          ...(reason === undefined ? {} : { reason })
        })
      });
    },
    async uploadDeliveryProof(taskId, file) {
      if (typeof taskId !== "string" || !taskId.trim()) throw new TypeError("invalid_task_id");
      if (!file || typeof file.arrayBuffer !== "function" ||
          !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
          !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 10 * 1024 * 1024) {
        throw new TypeError("invalid_delivery_proof_file");
      }
      if (!globalThis.crypto?.subtle) throw new TypeError("secure_file_hashing_unavailable");
      const bytes = await file.arrayBuffer();
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      const contentSha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
      const intent = await request(`/api/v1/courier/tasks/${encodeURIComponent(taskId)}/proof-upload`, {
        method: "POST",
        body: JSON.stringify({ contentType: file.type, contentLength: file.size, contentSha256 })
      });
      if (!intent || typeof intent.uploadUrl !== "string" ||
          typeof intent.uploadId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(intent.uploadId) ||
          !intent.requiredHeaders || typeof intent.requiredHeaders !== "object" ||
          Array.isArray(intent.requiredHeaders)) {
        throw new CourierApiError("invalid_delivery_proof_upload_response", 502, intent);
      }
      const signedHeaders = Object.fromEntries(
        Object.entries(intent.requiredHeaders).map(([name, value]) => [name.toLowerCase(), value])
      );
      if (Object.keys(signedHeaders).length !== 2 ||
          signedHeaders["content-type"] !== file.type ||
          signedHeaders["if-none-match"] !== "*") {
        throw new CourierApiError("invalid_delivery_proof_upload_headers", 502, null);
      }
      let uploadUrl;
      try { uploadUrl = new URL(intent.uploadUrl); } catch {
        throw new CourierApiError("invalid_delivery_proof_upload_url", 502, null);
      }
      if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password ||
          uploadUrl.hash || !uploadUrl.hostname) {
        throw new CourierApiError("insecure_delivery_proof_upload_url", 502, null);
      }
      const uploaded = await fetchImpl(uploadUrl.toString(), {
        method: "PUT",
        headers: signedHeaders,
        body: file,
        // A redirect could disclose the signed URL to an untrusted destination.
        redirect: "error"
      });
      if (!uploaded.ok) {
        throw new CourierApiError("delivery_proof_storage_upload_failed", uploaded.status, null);
      }
      return request(`/api/v1/courier/tasks/${encodeURIComponent(taskId)}/proof-upload/${encodeURIComponent(intent.uploadId)}/complete`, {
        method: "POST"
      });
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
