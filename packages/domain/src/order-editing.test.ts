import { describe, expect, it } from "vitest";
import {
  PAID_ORDER_EDIT_WINDOW_MS,
  distanceBetweenCoordinatesMeters,
  evaluatePaidOrderEditWindow,
  validateDeliveryDestinationChange
} from "./order-editing.js";

describe("paid order editing", () => {
  const capturedAt = "2026-11-08T12:00:00.000Z";

  it("allows edits during the five seconds after confirmed payment capture", () => {
    expect(evaluatePaidOrderEditWindow({
      paymentCapturedAtUtc: capturedAt, nowUtc: "2026-11-08T12:00:04.999Z", status: "confirmed"
    })).toEqual({
      allowed: true,
      editUntilUtc: new Date(Date.parse(capturedAt) + PAID_ORDER_EDIT_WINDOW_MS).toISOString(),
      remainingMilliseconds: 1
    });
  });

  it("closes the window after five seconds and rejects invalid timestamps", () => {
    expect(evaluatePaidOrderEditWindow({
      paymentCapturedAtUtc: capturedAt, nowUtc: "2026-11-08T12:00:05.001Z", status: "confirmed"
    })).toMatchObject({ allowed: false, reason: "edit_window_expired" });
    expect(evaluatePaidOrderEditWindow({
      paymentCapturedAtUtc: "bad", nowUtc: capturedAt, status: "confirmed"
    })).toMatchObject({ allowed: false, reason: "invalid_payment_time" });
  });

  it("blocks edits after fulfillment begins or a task is dispatched", () => {
    expect(evaluatePaidOrderEditWindow({
      paymentCapturedAtUtc: capturedAt, nowUtc: "2026-11-08T12:00:01.000Z", status: "preparing"
    })).toMatchObject({ allowed: false, reason: "fulfillment_already_started" });
    expect(evaluatePaidOrderEditWindow({
      paymentCapturedAtUtc: capturedAt, nowUtc: "2026-11-08T12:00:01.000Z",
      status: "confirmed", fulfillmentTaskDispatched: true
    })).toMatchObject({ allowed: false, reason: "fulfillment_already_started" });
  });
});

describe("delivery destination changes", () => {
  const serviceArea = { id: "jubail-core", center: { latitude: 27.0046, longitude: 49.646 }, radiusMeters: 10_000 };
  const quote = {
    branchId: "branch-new", deliveryFeeMinor: 1500, totalMinor: 51500,
    currency: "SAR", estimatedDeliveryAtUtc: "2026-11-08T13:00:00.000Z",
    quoteReference: "quote-123", expiresAtUtc: "2026-11-08T12:05:00.000Z"
  };

  it("accepts an in-zone destination and returns the repriced quote and changed branch", () => {
    expect(validateDeliveryDestinationChange({
      destination: { latitude: 27.01, longitude: 49.65 },
      serviceArea, currentBranchId: "branch-old", quote,
      nowUtc: "2026-11-08T12:00:00.000Z"
    })).toMatchObject({ allowed: true, quote, changedBranch: true });
  });

  it("rejects a destination beyond the agreed delivery radius", () => {
    expect(validateDeliveryDestinationChange({
      destination: { latitude: 27.2, longitude: 49.65 },
      serviceArea, currentBranchId: "branch-old", quote,
      nowUtc: "2026-11-08T12:00:00.000Z"
    })).toEqual({ allowed: false, reason: "outside_service_area" });
  });

  it("rejects expired or malformed server quotes", () => {
    expect(validateDeliveryDestinationChange({
      destination: { latitude: 27.01, longitude: 49.65 },
      serviceArea, currentBranchId: "branch-old",
      quote: { ...quote, expiresAtUtc: "2026-11-08T11:59:00.000Z" },
      nowUtc: "2026-11-08T12:00:00.000Z"
    })).toEqual({ allowed: false, reason: "invalid_quote" });
  });

  it("calculates geographic distance in meters", () => {
    expect(distanceBetweenCoordinatesMeters(
      { latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }
    )).toBeGreaterThan(111_000);
  });
});
