import { describe, expect, it } from "vitest";
import {
  buildScheduledFulfillmentTasks,
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

  it("creates immediate reservation and delayed preparation/dispatch tasks", () => {
    const plan = {
      orderId: "order-1",
      fulfillmentType: "home_delivery" as const,
      scheduledFor: "2026-11-07T17:00:00+03:00",
      scheduledForUtc: "2026-11-07T14:00:00.000Z",
      paymentDueAt: "2026-11-07T09:00:00.000Z",
      inventoryReservationDueAt: "2026-11-07T09:00:00.000Z",
      preparationReleaseAtUtc: "2026-11-07T13:10:00.000Z",
      courierDispatchAtUtc: "2026-11-07T13:40:00.000Z",
      estimate: { preparationMinutes: 30, bufferMinutes: 0, travelMinutes: 20 },
      createdAt: "2026-11-07T09:00:00.000Z"
    };
    const tasks = buildScheduledFulfillmentTasks(plan, 1);
    expect(tasks.map(task => task.taskType)).toEqual([
      "merchant_preparation", "courier_dispatch"
    ]);
    expect(tasks[0]?.executeAtUtc).toBe(plan.preparationReleaseAtUtc);
    expect(tasks[1]?.executeAtUtc).toBe(plan.courierDispatchAtUtc);
    expect(tasks.some(task => task.taskType === "merchant_reservation")).toBe(false);
    expect(new Set(tasks.map(task => task.idempotencyKey)).size).toBe(2);
  });

  it("creates a shopper collection task instead of a courier dispatch task", () => {
    const plan = {
      orderId: "order-2",
      fulfillmentType: "personal_shopper_pickup" as const,
      scheduledFor: "2026-11-07T17:00:00+03:00",
      scheduledForUtc: "2026-11-07T14:00:00.000Z",
      paymentDueAt: "2026-11-07T09:00:00.000Z",
      inventoryReservationDueAt: "2026-11-07T09:00:00.000Z",
      preparationReleaseAtUtc: "2026-11-07T13:30:00.000Z",
      estimate: { preparationMinutes: 30, bufferMinutes: 0, travelMinutes: 0 },
      createdAt: "2026-11-07T09:00:00.000Z"
    };
    expect(buildScheduledFulfillmentTasks(plan, 1).map(task => task.taskType))
      .toEqual(["shopper_collection"]);
  });

  it("creates deterministic idempotency keys", () => {
    expect(scheduledFulfillmentIdempotencyKey("order-1", "merchant_reservation", 2))
      .toBe("scheduled-fulfillment:order-1:merchant_reservation:v2");
    expect(scheduledFulfillmentIdempotencyKey(" ", "merchant_reservation", 2)).toBeNull();
    expect(scheduledFulfillmentIdempotencyKey("order-1", "merchant_reservation", 0)).toBeNull();
  });
});

