export const COURIER_DISPATCH_OFFER_STATUSES = [
  "offered", "accepted", "declined", "expired", "cancelled"
] as const;

export type CourierDispatchOfferStatus = (typeof COURIER_DISPATCH_OFFER_STATUSES)[number];

export interface CourierDispatchOffer {
  id: string;
  tenantId: string;
  taskId: string;
  courierId: string;
  status: CourierDispatchOfferStatus;
  version: number;
  createdAtUtc: string;
  expiresAtUtc: string;
  respondedAtUtc: string | null;
  terminalReason: string | null;
}

export interface CourierDispatchOfferTransitionContext {
  actorId: string;
  actorRole: "courier" | "dispatcher" | "system";
  expectedVersion: number;
  occurredAtUtc: string;
  /** Must be freshly checked inside the acceptance transaction by the caller. */
  courierEligible?: boolean;
  reason?: string;
}

export type CourierDispatchOfferTransitionResult =
  | { ok: true; offer: CourierDispatchOffer; previousStatus: "offered" }
  | { ok: false; reason:
      | "invalid_offer" | "missing_actor" | "actor_not_assigned"
      | "role_not_allowed" | "version_conflict" | "offer_not_pending"
      | "offer_expired" | "courier_no_longer_eligible"
      | "reason_required" | "invalid_timestamp" };

/**
 * Pure offer state transition. Callers must persist it transactionally, lock the
 * offer and delivery task, and re-check courier capacity before accepting.
 * This function alone never reserves capacity or assigns a delivery task.
 */
export function transitionCourierDispatchOffer(
  current: CourierDispatchOffer,
  nextStatus: CourierDispatchOfferStatus,
  context: CourierDispatchOfferTransitionContext
): CourierDispatchOfferTransitionResult {
  const createdAt = Date.parse(current.createdAtUtc);
  const expiresAt = Date.parse(current.expiresAtUtc);
  const occurredAt = Date.parse(context.occurredAtUtc);
  if (!current.id.trim() || !current.tenantId.trim() || !current.taskId.trim() ||
      !current.courierId.trim() || !Number.isSafeInteger(current.version) ||
      current.version < 1 || !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) || expiresAt <= createdAt ||
      (current.respondedAtUtc !== null && !Number.isFinite(Date.parse(current.respondedAtUtc))) ||
      !COURIER_DISPATCH_OFFER_STATUSES.includes(current.status)) {
    return { ok: false, reason: "invalid_offer" };
  }
  if (!context.actorId.trim()) return { ok: false, reason: "missing_actor" };
  if (!Number.isFinite(occurredAt)) return { ok: false, reason: "invalid_timestamp" };
  if (context.expectedVersion !== current.version) return { ok: false, reason: "version_conflict" };
  if (current.status !== "offered" || current.respondedAtUtc !== null) {
    return { ok: false, reason: "offer_not_pending" };
  }

  if (nextStatus === "accepted" || nextStatus === "declined") {
    if (context.actorRole !== "courier") return { ok: false, reason: "role_not_allowed" };
    if (context.actorId !== current.courierId) return { ok: false, reason: "actor_not_assigned" };
    if (occurredAt >= expiresAt) return { ok: false, reason: "offer_expired" };
    if (nextStatus === "accepted" && context.courierEligible !== true) {
      return { ok: false, reason: "courier_no_longer_eligible" };
    }
    if (nextStatus === "declined" && !context.reason?.trim()) {
      return { ok: false, reason: "reason_required" };
    }
  } else if (nextStatus === "expired") {
    if (context.actorRole !== "system") return { ok: false, reason: "role_not_allowed" };
    if (occurredAt < expiresAt) return { ok: false, reason: "offer_not_pending" };
  } else if (nextStatus === "cancelled") {
    if (context.actorRole !== "dispatcher") return { ok: false, reason: "role_not_allowed" };
    if (!context.reason?.trim()) return { ok: false, reason: "reason_required" };
  } else {
    return { ok: false, reason: "offer_not_pending" };
  }

  return {
    ok: true,
    previousStatus: "offered",
    offer: {
      ...current,
      status: nextStatus,
      version: current.version + 1,
      respondedAtUtc: new Date(occurredAt).toISOString(),
      terminalReason: nextStatus === "declined" || nextStatus === "cancelled"
        ? context.reason!.trim()
        : current.terminalReason
    }
  };
}
