export type CourierVehicleType = "motorcycle" | "car" | "van";

export interface CourierDispatchTaskRequirements {
  taskId: string;
  serviceZoneId: string;
  acceptedVehicleTypes: readonly CourierVehicleType[];
  packageWeightGrams: number;
  packageVolumeLiters: number;
  maxOffers: number;
}

export interface CourierDispatchCandidate {
  courierId: string;
  accountStatus: "active" | "suspended";
  verificationStatus: "verified" | "pending" | "rejected";
  available: boolean;
  serviceZoneIds: readonly string[];
  vehicleType: CourierVehicleType;
  capacityWeightGrams: number;
  capacityVolumeLiters: number;
  activeTaskCount: number;
  maxConcurrentTasks: number;
  distanceToPickupMeters: number;
}

export interface RankedCourierDispatchCandidate {
  courierId: string;
  vehicleType: CourierVehicleType;
  activeTaskCount: number;
  distanceToPickupMeters: number;
}

/**
 * Builds a fail-closed courier offer shortlist.
 *
 * This is a recommendation/offer-selection primitive only: it does not assign
 * a task, reserve capacity, reveal customer data, or start location tracking.
 * A production acceptance endpoint must re-check eligibility and capacity
 * transactionally before it records an assignment.
 */
export function rankEligibleCourierOffers(input: {
  task: CourierDispatchTaskRequirements;
  candidates: readonly CourierDispatchCandidate[];
}): readonly RankedCourierDispatchCandidate[] {
  const { task, candidates } = input;
  if (!task.taskId.trim() || !task.serviceZoneId.trim() ||
      task.acceptedVehicleTypes.length === 0 ||
      task.acceptedVehicleTypes.some(type => !isVehicleType(type)) ||
      !Number.isSafeInteger(task.packageWeightGrams) || task.packageWeightGrams <= 0 ||
      !Number.isSafeInteger(task.packageVolumeLiters) || task.packageVolumeLiters <= 0 ||
      !Number.isSafeInteger(task.maxOffers) || task.maxOffers < 1 || task.maxOffers > 100) {
    throw new Error("invalid_courier_dispatch_task");
  }

  const seen = new Set<string>();
  for (const courier of candidates) {
    if (!courier.courierId.trim() || seen.has(courier.courierId) ||
        !isVehicleType(courier.vehicleType) ||
        !Number.isSafeInteger(courier.capacityWeightGrams) || courier.capacityWeightGrams < 0 ||
        !Number.isSafeInteger(courier.capacityVolumeLiters) || courier.capacityVolumeLiters < 0 ||
        !Number.isSafeInteger(courier.activeTaskCount) || courier.activeTaskCount < 0 ||
        !Number.isSafeInteger(courier.maxConcurrentTasks) || courier.maxConcurrentTasks < 0 ||
        !Number.isSafeInteger(courier.distanceToPickupMeters) || courier.distanceToPickupMeters < 0 ||
        !Array.isArray(courier.serviceZoneIds) ||
        courier.serviceZoneIds.some(zone => typeof zone !== "string" || !zone.trim())) {
      throw new Error("invalid_courier_dispatch_candidate");
    }
    seen.add(courier.courierId);
  }

  return candidates
    .filter(courier =>
      courier.accountStatus === "active" &&
      courier.verificationStatus === "verified" &&
      courier.available &&
      courier.serviceZoneIds.includes(task.serviceZoneId) &&
      task.acceptedVehicleTypes.includes(courier.vehicleType) &&
      courier.capacityWeightGrams >= task.packageWeightGrams &&
      courier.capacityVolumeLiters >= task.packageVolumeLiters &&
      courier.activeTaskCount < courier.maxConcurrentTasks
    )
    // Prefer the least-loaded eligible courier, then the shortest pickup
    // distance. Stable IDs make ties deterministic across retries.
    .sort((a, b) =>
      a.activeTaskCount - b.activeTaskCount ||
      a.distanceToPickupMeters - b.distanceToPickupMeters ||
      a.courierId.localeCompare(b.courierId)
    )
    .slice(0, task.maxOffers)
    .map(courier => ({
      courierId: courier.courierId,
      vehicleType: courier.vehicleType,
      activeTaskCount: courier.activeTaskCount,
      distanceToPickupMeters: courier.distanceToPickupMeters
    }));
}

function isVehicleType(value: unknown): value is CourierVehicleType {
  return value === "motorcycle" || value === "car" || value === "van";
}
