import { describe, expect, it } from "vitest";
import { rankEligibleCourierOffers, type CourierDispatchCandidate } from "./courier-dispatch.js";

const courier = (overrides: Partial<CourierDispatchCandidate> = {}): CourierDispatchCandidate => ({
  courierId: "courier-1",
  accountStatus: "active",
  verificationStatus: "verified",
  available: true,
  serviceZoneIds: ["khobar-central"],
  vehicleType: "car",
  capacityWeightGrams: 20_000,
  capacityVolumeLiters: 100,
  activeTaskCount: 0,
  maxConcurrentTasks: 2,
  distanceToPickupMeters: 1_000,
  ...overrides
});

const task = {
  taskId: "delivery-1",
  serviceZoneId: "khobar-central",
  acceptedVehicleTypes: ["car", "van"] as const,
  packageWeightGrams: 5_000,
  packageVolumeLiters: 20,
  maxOffers: 5
};

describe("courier dispatch offer ranking", () => {
  it("filters unverified, unavailable, out-of-zone and capacity-ineligible couriers", () => {
    const result = rankEligibleCourierOffers({
      task,
      candidates: [
        courier({ courierId: "eligible" }),
        courier({ courierId: "unverified", verificationStatus: "pending" }),
        courier({ courierId: "busy", activeTaskCount: 2 }),
        courier({ courierId: "wrong-zone", serviceZoneIds: ["dhahran"] }),
        courier({ courierId: "too-heavy", capacityWeightGrams: 4_999 }),
        courier({ courierId: "offline", available: false })
      ]
    });
    expect(result.map(item => item.courierId)).toEqual(["eligible"]);
  });

  it("ranks by workload, then pickup distance, then stable courier ID", () => {
    const result = rankEligibleCourierOffers({
      task,
      candidates: [
        courier({ courierId: "far", activeTaskCount: 0, distanceToPickupMeters: 3_000 }),
        courier({ courierId: "near", activeTaskCount: 0, distanceToPickupMeters: 500 }),
        courier({ courierId: "least-loaded", activeTaskCount: 0, distanceToPickupMeters: 500 }),
        courier({ courierId: "more-loaded", activeTaskCount: 1, distanceToPickupMeters: 100 })
      ]
    });
    expect(result.map(item => item.courierId)).toEqual([
      "least-loaded", "near", "far", "more-loaded"
    ]);
  });

  it("limits the offer shortlist without assigning any courier", () => {
    const result = rankEligibleCourierOffers({
      task: { ...task, maxOffers: 2 },
      candidates: [courier({ courierId: "a" }), courier({ courierId: "b" }), courier({ courierId: "c" })]
    });
    expect(result).toHaveLength(2);
    expect(result.every(item => item.activeTaskCount === 0)).toBe(true);
  });

  it("rejects duplicate courier identities and invalid task requirements", () => {
    expect(() => rankEligibleCourierOffers({
      task,
      candidates: [courier(), courier()]
    })).toThrow("invalid_courier_dispatch_candidate");
    expect(() => rankEligibleCourierOffers({
      task: { ...task, packageWeightGrams: -1 },
      candidates: []
    })).toThrow("invalid_courier_dispatch_task");
  });

  it("rejects invalid capacity and distance data rather than ranking it", () => {
    expect(() => rankEligibleCourierOffers({
      task,
      candidates: [courier({ distanceToPickupMeters: Number.NaN })]
    })).toThrow("invalid_courier_dispatch_candidate");
  });
});
