export const ORDER_STATUSES = [
  "draft", "pending_validation", "awaiting_payment", "confirmed",
  "merchant_acceptance_pending", "preparing", "ready_for_pickup",
  "pickup_in_progress", "in_transit", "out_for_delivery", "delivered",
  "completed", "on_hold", "stock_unavailable", "payment_failed",
  "merchant_rejected", "delivery_failed", "cancellation_requested",
  "cancelled", "return_requested", "return_in_progress", "returned",
  "refund_pending", "refunded", "disputed"
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderLifecycle {
  orderId: string;
  status: OrderStatus;
  version: number;
  updatedAt: string;
  merchantId?: string;
  branchId?: string;
  parentOrderId?: string;
}

export interface OrderTransitionContext {
  actorId: string;
  actorRole: string;
  occurredAt: string;
  expectedVersion: number;
  paymentAuthorized?: boolean;
  inventoryReserved?: boolean;
  deliveryProofVerified?: boolean;
  refundConfirmed?: boolean;
  reason?: string;
}

export type OrderTransitionResult =
  | { ok: true; order: OrderLifecycle; previousStatus: OrderStatus }
  | { ok: false; reason: "version_conflict" | "invalid_transition" | "missing_actor" |
      "missing_reason" | "payment_not_authorized" | "inventory_not_reserved" |
      "delivery_proof_missing" | "refund_not_confirmed" };

const transitions: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  draft: ["pending_validation", "cancelled"],
  pending_validation: ["awaiting_payment", "stock_unavailable", "cancelled", "on_hold"],
  awaiting_payment: ["confirmed", "payment_failed", "cancelled", "on_hold"],
  confirmed: ["merchant_acceptance_pending", "preparing", "cancellation_requested", "on_hold"],
  merchant_acceptance_pending: ["preparing", "merchant_rejected", "cancellation_requested", "on_hold"],
  preparing: ["ready_for_pickup", "stock_unavailable", "cancellation_requested", "on_hold"],
  ready_for_pickup: ["pickup_in_progress", "cancellation_requested", "on_hold"],
  pickup_in_progress: ["in_transit", "delivery_failed", "on_hold"],
  in_transit: ["out_for_delivery", "delivery_failed", "on_hold"],
  out_for_delivery: ["delivered", "delivery_failed", "on_hold"],
  delivered: ["completed", "return_requested", "disputed"],
  completed: ["return_requested", "disputed"],
  on_hold: ["confirmed", "merchant_acceptance_pending", "preparing", "ready_for_pickup", "pickup_in_progress", "in_transit", "out_for_delivery", "cancellation_requested", "cancelled", "disputed"],
  stock_unavailable: ["pending_validation", "cancelled"],
  payment_failed: ["awaiting_payment", "cancelled"],
  merchant_rejected: ["cancelled", "refund_pending"],
  delivery_failed: ["pickup_in_progress", "in_transit", "out_for_delivery", "cancelled", "disputed"],
  cancellation_requested: ["cancelled", "preparing", "ready_for_pickup", "refund_pending", "disputed"],
  cancelled: ["refund_pending", "refunded"],
  return_requested: ["return_in_progress", "disputed"],
  return_in_progress: ["returned", "disputed"],
  returned: ["refund_pending", "refunded", "disputed"],
  refund_pending: ["refunded", "disputed"],
  refunded: ["disputed"],
  disputed: ["completed", "cancelled", "refund_pending", "refunded"]
};

const reasonRequired = new Set<OrderStatus>([
  "on_hold", "stock_unavailable", "payment_failed", "merchant_rejected",
  "delivery_failed", "cancellation_requested", "cancelled", "disputed",
  "return_requested", "refund_pending"
]);

export function transitionOrder(
  current: OrderLifecycle,
  nextStatus: OrderStatus,
  context: OrderTransitionContext
): OrderTransitionResult {
  if (!context.actorId.trim()) return { ok: false, reason: "missing_actor" };
  if (current.version !== context.expectedVersion) return { ok: false, reason: "version_conflict" };
  if (!transitions[current.status].includes(nextStatus)) return { ok: false, reason: "invalid_transition" };
  if (reasonRequired.has(nextStatus) && !context.reason?.trim()) return { ok: false, reason: "missing_reason" };
  if (nextStatus === "confirmed" &&
      current.status === "awaiting_payment" && context.paymentAuthorized !== true) {
    return { ok: false, reason: "payment_not_authorized" };
  }
  if (nextStatus === "confirmed" && context.inventoryReserved !== true) {
    return { ok: false, reason: "inventory_not_reserved" };
  }
  if (nextStatus === "delivered" && context.deliveryProofVerified !== true) {
    return { ok: false, reason: "delivery_proof_missing" };
  }
  if (nextStatus === "refunded" && context.refundConfirmed !== true) {
    return { ok: false, reason: "refund_not_confirmed" };
  }
  const updatedAt = new Date(context.occurredAt);
  if (!Number.isFinite(updatedAt.getTime())) return { ok: false, reason: "invalid_transition" };
  return {
    ok: true,
    previousStatus: current.status,
    order: { ...current, status: nextStatus, version: current.version + 1, updatedAt: updatedAt.toISOString() }
  };
}

export function aggregateParentOrderStatus(suborders: readonly OrderStatus[]): OrderStatus {
  if (suborders.length === 0) throw new Error("A parent order must contain at least one suborder");
  if (suborders.every(status => status === "cancelled" || status === "refunded")) return "cancelled";
  if (suborders.every(status => status === "completed" || status === "refunded")) return "completed";
  if (suborders.every(status => status === "delivered" || status === "completed" || status === "refunded")) return "delivered";
  if (suborders.some(status => status === "disputed")) return "disputed";
  if (suborders.some(status => status === "on_hold" || status === "delivery_failed")) return "on_hold";
  if (suborders.some(status => status === "return_requested" || status === "return_in_progress" || status === "returned" || status === "refund_pending")) return "return_in_progress";
  if (suborders.some(status => status === "payment_failed" || status === "stock_unavailable" || status === "merchant_rejected")) return "on_hold";
  if (suborders.every(status => status === "draft")) return "draft";
  if (suborders.every(status => status === "pending_validation" || status === "draft")) return "pending_validation";
  if (suborders.every(status => status === "awaiting_payment" || status === "pending_validation" || status === "draft")) return "awaiting_payment";
  if (suborders.every(status => ["confirmed", "merchant_acceptance_pending", "preparing"].includes(status))) return "preparing";
  if (suborders.every(status => ["ready_for_pickup", "pickup_in_progress", "in_transit", "out_for_delivery", "delivered", "completed"].includes(status))) {
    return suborders.every(status => status === "completed" || status === "delivered") ? "delivered" : "in_transit";
  }
  return "preparing";
}
