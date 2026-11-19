export const COURIER_TASK_STATUSES = [
  "offered", "accepted", "heading_to_pickup", "arrived_at_pickup",
  "picked_up", "in_transit", "arrived_at_dropoff", "delivered",
  "declined", "cancelled", "failed"
] as const;

export type CourierTaskStatus = (typeof COURIER_TASK_STATUSES)[number];

export interface CourierTask {
  id: string;
  tenantId: string;
  orderId: string;
  suborderId: string;
  courierId: string;
  status: CourierTaskStatus;
  version: number;
  updatedAtUtc: string;
}

export interface CourierTaskTransitionContext {
  actorId: string;
  actorRole: "courier" | "dispatcher";
  expectedVersion: number;
  occurredAtUtc: string;
  pickupCodeVerified?: boolean;
  deliveryProofVerified?: boolean;
  reason?: string;
}

export type CourierTaskTransitionResult =
  | { ok: true; task: CourierTask; previousStatus: CourierTaskStatus }
  | { ok: false; reason:
      | "missing_actor" | "actor_not_assigned" | "version_conflict"
      | "invalid_transition" | "invalid_timestamp" | "pickup_code_not_verified"
      | "delivery_proof_missing" | "reason_required" | "role_not_allowed" };

const transitions: Readonly<Record<CourierTaskStatus, readonly CourierTaskStatus[]>> = {
  offered: ["accepted", "declined", "cancelled"],
  accepted: ["heading_to_pickup", "cancelled", "failed"],
  heading_to_pickup: ["arrived_at_pickup", "cancelled", "failed"],
  arrived_at_pickup: ["picked_up", "cancelled", "failed"],
  picked_up: ["in_transit", "failed"],
  in_transit: ["arrived_at_dropoff", "failed"],
  arrived_at_dropoff: ["delivered", "failed"],
  delivered: [],
  declined: [],
  cancelled: [],
  failed: []
};

const reasonRequired = new Set<CourierTaskStatus>(["declined", "cancelled", "failed"]);

/**
 * Pure courier-task state transition. Persistence must additionally enforce
 * optimistic concurrency and append an immutable audit event in one transaction.
 * Pickup and delivery are not complete until their respective evidence is verified.
 */
export function transitionCourierTask(
  current: CourierTask,
  nextStatus: CourierTaskStatus,
  context: CourierTaskTransitionContext
): CourierTaskTransitionResult {
  if (!context.actorId.trim()) return { ok: false, reason: "missing_actor" };
  if (context.actorRole !== "courier" && context.actorRole !== "dispatcher") {
    return { ok: false, reason: "role_not_allowed" };
  }
  if (context.actorRole === "courier" && context.actorId !== current.courierId) {
    return { ok: false, reason: "actor_not_assigned" };
  }
  if (context.actorRole === "dispatcher" && nextStatus !== "cancelled" && nextStatus !== "failed") {
    return { ok: false, reason: "role_not_allowed" };
  }
  if (!Number.isSafeInteger(current.version) || current.version < 0 ||
      context.expectedVersion !== current.version) {
    return { ok: false, reason: "version_conflict" };
  }
  if (!transitions[current.status].includes(nextStatus)) {
    return { ok: false, reason: "invalid_transition" };
  }
  if (reasonRequired.has(nextStatus) && !context.reason?.trim()) {
    return { ok: false, reason: "reason_required" };
  }
  if (nextStatus === "picked_up" && context.pickupCodeVerified !== true) {
    return { ok: false, reason: "pickup_code_not_verified" };
  }
  if (nextStatus === "delivered" && context.deliveryProofVerified !== true) {
    return { ok: false, reason: "delivery_proof_missing" };
  }
  const timestamp = Date.parse(context.occurredAtUtc);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "invalid_timestamp" };

  return {
    ok: true,
    previousStatus: current.status,
    task: {
      ...current,
      status: nextStatus,
      version: current.version + 1,
      updatedAtUtc: new Date(timestamp).toISOString()
    }
  };
}
