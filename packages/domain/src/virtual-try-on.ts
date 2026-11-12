export const VIRTUAL_TRY_ON_MODES = ["photo", "video", "live_camera"] as const;
export type VirtualTryOnMode = (typeof VIRTUAL_TRY_ON_MODES)[number];

export type VirtualTryOnStatus =
  | "queued" | "processing" | "ready" | "failed" | "cancelled" | "expired";

export interface VirtualTryOnRequest {
  id: string;
  tenantId: string;
  customerId: string;
  productId: string;
  productVariantId: string;
  /** Exact, source-attributed chart for this product/variant; used for size guidance, not a fit guarantee. */
  sizeChartId: string;
  mode: VirtualTryOnMode;
  /** References to private media assets; raw image/video bytes must not be stored in this record. */
  customerMediaAssetId: string;
  /** For live camera, this is a short-lived session reference created by the media gateway. */
  liveSessionId?: string;
  consent: {
    processingAccepted: boolean;
    retentionAccepted: boolean;
    consentedAtUtc: string;
    policyVersion: string;
  };
  createdAtUtc: string;
  expiresAtUtc: string;
}

export interface VirtualTryOnJob {
  request: VirtualTryOnRequest;
  status: VirtualTryOnStatus;
  providerJobId?: string;
  resultMediaAssetId?: string;
  failureCode?: string;
}

const safeId = (value: string, max = 160) =>
  typeof value === "string" && value.length > 0 && value.length <= max &&
  /^[A-Za-z0-9._:-]+$/.test(value);

/** Validate a try-on request before queuing it. Media ownership, consent evidence and tenant authorization are checked by the API separately. */
export function validateVirtualTryOnRequest(
  request: VirtualTryOnRequest,
  nowUtc: string
): boolean {
  if (!safeId(request.id) || !safeId(request.tenantId) || !safeId(request.customerId) ||
      !safeId(request.productId) || !safeId(request.productVariantId) || !safeId(request.sizeChartId) ||
      !safeId(request.customerMediaAssetId)) return false;
  if (!VIRTUAL_TRY_ON_MODES.includes(request.mode)) return false;
  if (request.mode === "live_camera" && !safeId(request.liveSessionId ?? "")) return false;
  if (request.mode !== "live_camera" && request.liveSessionId !== undefined) return false;
  if (request.consent?.processingAccepted !== true || request.consent?.retentionAccepted !== true ||
      !safeId(request.consent.policyVersion, 80)) return false;
  const created = Date.parse(request.createdAtUtc);
  const expires = Date.parse(request.expiresAtUtc);
  const now = Date.parse(nowUtc);
  const consented = Date.parse(request.consent.consentedAtUtc);
  return [created, expires, now, consented].every(Number.isFinite) &&
    expires > created && now >= created && now < expires &&
    consented >= created && consented <= now;
}

/** A completed result is usable only while its private media asset is present and the request has not expired. */
export function isVirtualTryOnResultAvailable(job: VirtualTryOnJob, nowUtc: string): boolean {
  if (job.status !== "ready" || !safeId(job.resultMediaAssetId ?? "")) return false;
  const now = Date.parse(nowUtc);
  const expires = Date.parse(job.request.expiresAtUtc);
  return Number.isFinite(now) && Number.isFinite(expires) && now < expires;
}
