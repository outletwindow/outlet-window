import { describe, expect, it } from "vitest";
import {
  createScheduledOrderPlan,
  isFulfillmentSlotAvailable,
  type FulfillmentSlot
} from "./scheduled-fulfillment.js";

const now = "2026-11-07T12:00:00+03:00";

describe("scheduled fulfillment planning", () => {
  it("charges and requests inventory reservation at confirmation, then releases preparation at the calculated time", () => {
    const plan = createScheduledOrderPlan({
      orderId: "order-1",
      fulfillmentType: "home_delivery",
      scheduledFor: "2026-11-07T17:00:00+03:00",
      now,
      estimate: { preparationMinutes: 30, bufferMinutes: 0, travelMinutes: 20 }
    });
    expect(plan).not.toBeNull();
    expect(plan?.paymentDueAt).toBe("2026-11-07T09:00:00.000Z");
    expect(plan?.inventoryReservationDueAt).toBe("2026-11-07T09:00:00.000Z");
    expect(plan?.preparationReleaseAtUtc).toBe("2026-11-07T13:10:00.000Z");
    expect(plan?.courierDispatchAtUtc).toBe("2026-11-07T13:40:00.000Z");
    expect(plan?.scheduledForUtc).toBe("2026-11-07T14:00:00.000Z");
  });

  it("does not release preparation before now for short-notice orders", () => {
    const plan = createScheduledOrderPlan({
      orderId: "order-2",
      fulfillmentType: "store_pickup",
      scheduledFor: "2026-11-07T12:20:00+03:00",
      now,
      estimate: { preparationMinutes: 30, bufferMinutes: 5, travelMinutes: 0 }
    });
    expect(plan?.preparationReleaseAtUtc).toBe("2026-11-07T09:00:00.000Z");\n    expect(plan?.courierDispatchAtUtc).toBeUndefined();
  });

  it("rejects schedules without timezone, in the past, or beyond the horizon", () => {
    const estimate = { preparationMinutes: 30, bufferMinutes: 5, travelMinutes: 0 };
    expect(createScheduledOrderPlan({ orderId: "x", fulfillmentType: "store_pickup", scheduledFor: "2026-11-07T13:00:00", now, estimate })).toBeNull();
    expect(createScheduledOrderPlan({ orderId: "x", fulfillmentType: "store_pickup", scheduledFor: "2026-11-07T11:00:00+03:00", now, estimate })).toBeNull();
    expect(createScheduledOrderPlan({ orderId: "x", fulfillmentType: "store_pickup", scheduledFor: "2027-03-01T12:00:00+03:00", now, estimate })).toBeNull();
  });

  it("requires travel time only for home delivery", () => {
    expect(createScheduledOrderPlan({
      orderId: "x", fulfillmentType: "personal_shopper_pickup",
      scheduledFor: "2026-11-07T17:00:00+03:00", now,
      estimate: { preparationMinutes: 30, bufferMinutes: 0, travelMinutes: 10 }
    })).toBeNull();
  });

  it("checks slot capacity", () => {
    const slot: FulfillmentSlot = {
      id: "slot-1", fulfillmentType: "store_pickup",
      startsAtUtc: "2026-11-07T14:00:00Z", endsAtUtc: "2026-11-07T14:30:00Z",
      capacity: 10, reservedCount: 9
    };
    expect(isFulfillmentSlotAvailable(slot)).toBe(true);
    expect(isFulfillmentSlotAvailable({ ...slot, reservedCount: 10 })).toBe(false);
  });
});
