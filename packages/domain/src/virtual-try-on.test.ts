import { describe, expect, it } from "vitest";
import {
  isVirtualTryOnResultAvailable,
  validateVirtualTryOnRequest,
  type VirtualTryOnRequest
} from "./virtual-try-on.js";

const base: VirtualTryOnRequest = {
  id: "tryon-1", tenantId: "tenant-1", customerId: "customer-1",
  productId: "product-1", productVariantId: "variant-1", sizeChartId: "sizechart-1", mode: "photo",
  customerMediaAssetId: "private-media-1",
  consent: {
    processingAccepted: true, retentionAccepted: true,
    consentedAtUtc: "2026-11-08T10:00:00.000Z", policyVersion: "tryon-v1"
  },
  createdAtUtc: "2026-11-08T10:00:00.000Z",
  expiresAtUtc: "2026-11-08T10:30:00.000Z"
};

describe("virtual try-on request contract", () => {
  it.each(["photo", "video"] as const)("accepts consented %s requests", mode => {
    expect(validateVirtualTryOnRequest({ ...base, mode }, "2026-11-08T10:01:00.000Z")).toBe(true);
  });

  it("requires a short-lived live camera session reference", () => {
    expect(validateVirtualTryOnRequest({
      ...base, mode: "live_camera", liveSessionId: "camera-session-1"
    }, "2026-11-08T10:01:00.000Z")).toBe(true);
    expect(validateVirtualTryOnRequest({
      ...base, mode: "live_camera"
    }, "2026-11-08T10:01:00.000Z")).toBe(false);
  });

  it("rejects missing consent, invalid time windows and expired requests", () => {
    expect(validateVirtualTryOnRequest({
      ...base, consent: { ...base.consent, processingAccepted: false }
    }, "2026-11-08T10:01:00.000Z")).toBe(false);
    expect(validateVirtualTryOnRequest(base, "2026-11-08T10:30:00.000Z")).toBe(false);
    expect(validateVirtualTryOnRequest({
      ...base, expiresAtUtc: base.createdAtUtc
    }, "2026-11-08T10:01:00.000Z")).toBe(false);
  });

  it("exposes only ready results with a valid media reference before expiry", () => {
    const job = { request: base, status: "ready" as const, resultMediaAssetId: "render-1" };
    expect(isVirtualTryOnResultAvailable(job, "2026-11-08T10:10:00.000Z")).toBe(true);
    expect(isVirtualTryOnResultAvailable({ ...job, status: "processing" }, "2026-11-08T10:10:00.000Z")).toBe(false);
    expect(isVirtualTryOnResultAvailable(job, "2026-11-08T10:30:00.000Z")).toBe(false);
  });
});
