const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{32,256}$/;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

export class MerchantApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "MerchantApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function createMerchantApi({ baseUrl = "", token, fetchImpl = globalThis.fetch }) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) throw new TypeError("invalid_merchant_session_token");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch_unavailable");
  const configuredBase = String(baseUrl).trim();
  if (configuredBase) {
    let parsed;
    try { parsed = new URL(configuredBase); } catch { throw new TypeError("invalid_merchant_api_base_url"); }
    const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !localHttp) throw new TypeError("merchant_api_requires_https");
    if (parsed.username || parsed.password) throw new TypeError("invalid_merchant_api_base_url");
  }
  const root = configuredBase.replace(/\/+$/, "");
  const validId = value => typeof value === "string" && ID_PATTERN.test(value);

  return Object.freeze({
    async issuePickupCode({ merchantId, branchId, orderId, suborderId, taskId }) {
      if (![merchantId, branchId, orderId, suborderId, taskId].every(validId)) {
        throw new TypeError("invalid_pickup_code_scope");
      }
      const path = [
        "/api/v1/merchants/", encodeURIComponent(merchantId),
        "/branches/", encodeURIComponent(branchId),
        "/orders/", encodeURIComponent(orderId),
        "/suborders/", encodeURIComponent(suborderId),
        "/pickup-code"
      ].join("");
      const response = await fetchImpl(root + path, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ taskId })
      });
      let payload = null;
      try { payload = await response.json(); } catch { /* handled as an invalid API response */ }
      if (!response.ok) {
        throw new MerchantApiError(
          typeof payload?.error === "string" ? payload.error : "merchant_api_request_failed",
          response.status,
          payload
        );
      }
      if (!payload || payload.outcome !== "issued" ||
          typeof payload.code !== "string" || !/^\d{8}$/.test(payload.code) ||
          typeof payload.expiresAtUtc !== "string" ||
          !Number.isFinite(Date.parse(payload.expiresAtUtc))) {
        throw new MerchantApiError("invalid_pickup_code_response", 502, payload);
      }
      return Object.freeze({ code: payload.code, expiresAtUtc: payload.expiresAtUtc });
    }
  });
}
