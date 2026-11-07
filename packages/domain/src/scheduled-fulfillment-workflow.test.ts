import { describe, expect, it } from "vitest";
import {
  getScheduledCheckoutNextAction,
  scheduledFulfillmentIdempotencyKey,
  type ScheduledCheckoutSnapshot
} from "./scheduled-fulfillment-workflow.js";

const base: ScheduledCheckoutSnapshot = {
  orderId: "order-1",
  paymentState: "captured",
  inventoryState: "not_requested",
  alternativeChoice: "not_required",
  alternatives: []
};

describe("scheduled checkout orchestration decisions", () => {
  it("does not request stock before payment capture", () => {
    expect(getScheduledCheckoutNextAction({ ...base, paymentState: "failed" })).toBe("retry_payment");
  });

  it("requests branch reservation immediately after payment capture", () => {
    expect(getScheduledCheckoutNextAction(base)).toBe("request_inventory_reservation");
  });

  it("schedules timed preparation only after confirmed reservation", () => {
    expect(getScheduledCheckoutNextAction({ ...base, inventoryState: "reserved" }))
      .toBe("schedule_preparation_and_dispatch");
  });

  it("holds an unavailable item for customer alternative choice", () => {
    const alternatives = [{
      id: "branch-2", label: "Another branch", scheduledForUtc: "2026-11-08T14:00:00.000Z",
      priceDeltaMinor: 0, currency: "SAR", availabilityConfirmed: true
    }];
    expect(getScheduledCheckoutNextAction({
      ...base, inventoryState: "unavailable", alternativeChoice: "not_required", alternatives
    })).toBe("present_alternatives");
    expect(getScheduledCheckoutNextAction({
      ...base, inventoryState: "unavailable", alternativeChoice: "awaiting_customer", alternatives
    })).toBe("await_customer_choice");
  });

  it("processes refund only after decline or when no alternative exists", () => {
    expect(getScheduledCheckoutNextAction({
      ...base, inventoryState: "unavailable", alternativeChoice: "declined"
    })).toBe("process_refund");
    expect(getScheduledCheckoutNextAction({
      ...base, inventoryState: "unavailable"
    })).toBe("process_refund");
  });

  it("rejects inconsistent states for manual review", () => {
    expect(getScheduledCheckoutNextAction({
      ...base, inventoryState: "reserved", alternativeChoice: "accepted"
    })).toBe("manual_review");
  });

  it("creates deterministic idempotency keys", () => {
    expect(scheduledFulfillmentIdempotencyKey("order-1", "merchant_reservation", 2))
      .toBe("scheduled-fulfillment:order-1:merchant_reservation:v2");
    expect(scheduledFulfillmentIdempotencyKey(" ", "merchant_reservation", 2)).toBeNull();
    expect(scheduledFulfillmentIdempotencyKey("order-1", "merchant_reservation", 0)).toBeNull();
  });
});
