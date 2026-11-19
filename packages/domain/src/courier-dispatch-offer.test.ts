import { describe, expect, it } from "vitest";
import {
  transitionCourierDispatchOffer,
  type CourierDispatchOffer
} from "./courier-dispatch-offer.js";

const offer = (overrides: Partial<CourierDispatchOffer> = {}): CourierDispatchOffer => ({
  id: "offer-1",
  tenantId: "tenant-1",
  taskId: "task-1",
  courierId: "courier-1",
  status: "offered",
  version: 1,
  createdAtUtc: "2026-11-17T10:00:00.000Z",
  expiresAtUtc: "2026-11-17T10:05:00.000Z",
  respondedAtUtc: null,
  terminalReason: null,
  ...overrides
});

const courierContext = {
  actorId: "courier-1",
  actorRole: "courier" as const,
  expectedVersion: 1,
  occurredAtUtc: "2026-11-17T10:02:00.000Z"
};

describe("courier dispatch offer transitions", () => {
  it("accepts only the assigned courier while the offer is live and eligibility is rechecked", () => {
    expect(transitionCourierDispatchOffer(offer(), "accepted", {
      ...courierContext, courierEligible: true
    })).toMatchObject({
      ok: true, offer: { status: "accepted", version: 2, respondedAtUtc: "2026-11-17T10:02:00.000Z" }
    });
    expect(transitionCourierDispatchOffer(offer(), "accepted", {
      ...courierContext, courierEligible: false
    })).toEqual({ ok: false, reason: "courier_no_longer_eligible" });
    expect(transitionCourierDispatchOffer(offer(), "accepted", {
      ...courierContext, actorId: "another-courier", courierEligible: true
    })).toEqual({ ok: false, reason: "actor_not_assigned" });
  });

  it("rejects acceptance at or after expiry", () => {
    expect(transitionCourierDispatchOffer(offer(), "accepted", {
      ...courierContext, occurredAtUtc: "2026-11-17T10:05:00.000Z", courierEligible: true
    })).toEqual({ ok: false, reason: "offer_expired" });
  });

  it("requires a reason for decline and records it", () => {
    expect(transitionCourierDispatchOffer(offer(), "declined", courierContext))
      .toEqual({ ok: false, reason: "reason_required" });
    expect(transitionCourierDispatchOffer(offer(), "declined", {
      ...courierContext, reason: "Outside service area"
    })).toMatchObject({
      ok: true, offer: { status: "declined", terminalReason: "Outside service area", version: 2 }
    });
  });

  it("allows only the system to expire an offer after its deadline", () => {
    expect(transitionCourierDispatchOffer(offer(), "expired", {
      actorId: "scheduler", actorRole: "system", expectedVersion: 1,
      occurredAtUtc: "2026-11-17T10:04:59.999Z"
    })).toEqual({ ok: false, reason: "offer_not_pending" });
    expect(transitionCourierDispatchOffer(offer(), "expired", {
      actorId: "scheduler", actorRole: "system", expectedVersion: 1,
      occurredAtUtc: "2026-11-17T10:05:00.000Z"
    })).toMatchObject({ ok: true, offer: { status: "expired", version: 2 } });
  });

  it("allows a dispatcher to cancel with a reason, not accept for a courier", () => {
    expect(transitionCourierDispatchOffer(offer(), "cancelled", {
      actorId: "dispatcher-1", actorRole: "dispatcher", expectedVersion: 1,
      occurredAtUtc: "2026-11-17T10:02:00.000Z", reason: "Order cancelled"
    })).toMatchObject({ ok: true, offer: { status: "cancelled", terminalReason: "Order cancelled" } });
    expect(transitionCourierDispatchOffer(offer(), "accepted", {
      actorId: "dispatcher-1", actorRole: "dispatcher", expectedVersion: 1,
      occurredAtUtc: "2026-11-17T10:02:00.000Z", courierEligible: true
    })).toEqual({ ok: false, reason: "role_not_allowed" });
  });

  it("rejects stale, repeated, malformed, and already-responded offers", () => {
    expect(transitionCourierDispatchOffer(offer(), "accepted", {
      ...courierContext, expectedVersion: 0, courierEligible: true
    })).toEqual({ ok: false, reason: "version_conflict" });
    expect(transitionCourierDispatchOffer(offer({ status: "accepted", respondedAtUtc: "2026-11-17T10:01:00Z" }), "accepted", {
      ...courierContext, courierEligible: true
    })).toEqual({ ok: false, reason: "offer_not_pending" });
    expect(transitionCourierDispatchOffer(offer({ expiresAtUtc: "invalid" }), "accepted", {
      ...courierContext, courierEligible: true
    })).toEqual({ ok: false, reason: "invalid_offer" });
  });
});
