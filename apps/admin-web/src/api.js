const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{32,256}$/;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

export class AdminApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function createAdminApi({ baseUrl = "", token, fetchImpl = globalThis.fetch }) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) throw new TypeError("invalid_admin_session_token");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch_unavailable");
  const configuredBase = String(baseUrl).trim();
  if (configuredBase) {
    let parsed;
    try { parsed = new URL(configuredBase); } catch { throw new TypeError("invalid_admin_api_base_url"); }
    const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !localHttp) throw new TypeError("admin_api_requires_https");
    if (parsed.username || parsed.password) throw new TypeError("invalid_admin_api_base_url");
  }
  const root = configuredBase.replace(/\/+$/, "");
  async function request(path, init = {}) {
    const response = await fetchImpl(`${root}${path}`, {
      ...init,
      headers: { accept: "application/json", authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers }
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON error response */ }
    if (!response.ok) throw new AdminApiError(
      typeof payload?.error === "string" ? payload.error : "admin_api_request_failed", response.status, payload
    );
    return payload;
  }
  const validId = value => typeof value === "string" && ID_PATTERN.test(value);
  const send = (path, body) => request(path, { method: "POST", body: JSON.stringify(body) });
  return Object.freeze({
    async listProfiles(status = "") {
      if (status && !["pending", "active", "suspended"].includes(status)) throw new TypeError("invalid_profile_status");
      const query = new URLSearchParams({ limit: "200", ...(status ? { status } : {}) });
      const payload = await request(`/api/v1/platform/couriers?${query}`);
      if (!payload || !Array.isArray(payload.profiles) || payload.profiles.some(p =>
        !p || !validId(p.courierId) || !["pending", "active", "suspended"].includes(p.accountStatus) ||
        !["pending", "verified", "rejected"].includes(p.verificationStatus) ||
        !Number.isSafeInteger(p.maxConcurrentTasks))) throw new AdminApiError("invalid_admin_profiles_response", 502, payload);
      return payload.profiles;
    },
    async createProfile({ courierId, maxConcurrentTasks = 1 }) {
      if (!validId(courierId) || !Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1 || maxConcurrentTasks > 20)
        throw new TypeError("invalid_courier_profile");
      return send("/api/v1/platform/couriers", { courierId, maxConcurrentTasks });
    },
    async reviewProfile(courierId, decision) {
      if (!validId(courierId) || !["approve", "reject", "suspend", "reinstate"].includes(decision))
        throw new TypeError("invalid_courier_review");
      return send(`/api/v1/platform/couriers/${encodeURIComponent(courierId)}/review`, { decision });
    },
    async registerVehicle({ courierId, vehicleType, capacityWeightGrams, capacityVolumeLiters }) {
      if (!validId(courierId) || !["motorcycle", "car", "van"].includes(vehicleType) ||
          !Number.isSafeInteger(capacityWeightGrams) || capacityWeightGrams < 1 || capacityWeightGrams > 1_000_000 ||
          !Number.isSafeInteger(capacityVolumeLiters) || capacityVolumeLiters < 1 || capacityVolumeLiters > 10_000)
        throw new TypeError("invalid_courier_vehicle");
      return send("/api/v1/platform/courier-vehicles", { courierId, vehicleType, capacityWeightGrams, capacityVolumeLiters });
    },
    async listVehicles(status = "") {
      if (status && !["pending", "verified", "rejected"].includes(status)) throw new TypeError("invalid_vehicle_status");
      const query = new URLSearchParams({ limit: "200", ...(status ? { status } : {}) });
      const payload = await request(`/api/v1/platform/courier-vehicles?${query}`);
      if (!payload || !Array.isArray(payload.vehicles) || payload.vehicles.some(v =>
        !v || !validId(v.vehicleId) || !validId(v.courierId) ||
        !["motorcycle", "car", "van"].includes(v.vehicleType) ||
        !["pending", "verified", "rejected"].includes(v.verificationStatus) ||
        !Number.isSafeInteger(v.capacityWeightGrams) || !Number.isSafeInteger(v.capacityVolumeLiters) ||
        typeof v.active !== "boolean")) throw new AdminApiError("invalid_admin_vehicles_response", 502, payload);
      return payload.vehicles;
    },
    async reviewVehicle(vehicleId, decision) {
      if (!validId(vehicleId) || !["approve", "reject"].includes(decision)) throw new TypeError("invalid_vehicle_review");
      return send(`/api/v1/platform/courier-vehicles/${encodeURIComponent(vehicleId)}/review`, { decision });
    },
    async setServiceArea({ courierId, tenantId, serviceAreaId, action }) {
      if (![courierId, tenantId, serviceAreaId].every(validId) || !["grant", "revoke"].includes(action))
        throw new TypeError("invalid_courier_service_area");
      return send(`/api/v1/platform/courier-service-area-memberships/${action}`, { courierId, tenantId, serviceAreaId });
    }
  });
}
