import type { AlternativeFulfillmentOption, ScheduledOrderPlan } from "./scheduled-fulfillment.js";

export type ScheduledCheckoutPaymentState = "not_started" | "failed" | "captured";
export type ScheduledInventoryState = "not_requested" | "reserved" | "unavailable";
export type ScheduledAlternativeChoice = "not_required" | "awaiting_customer" | "accepted" | "declined";

export type ScheduledCheckoutNextAction =
  | "retry_payment"
  | "request_inventory_reservation"
  | "schedule_preparation_and_dispatch"
  | "present_alternatives"
  | "process_refund"
  | "await_customer_choice"
  | "manual_review";

export interface ScheduledCheckoutSnapshot {
  orderId: string;
  paymentState: ScheduledCheckoutPaymentState;
  inventoryState: ScheduledInventoryState;
  alternativeChoice: ScheduledAlternativeChoice;
  alternatives: readonly AlternativeFulfillmentOption[];
}

/**
 * Pure orchestration decision for the checkout saga.
 * The application layer must execute each action with provider idempotency keys,
 * persist every result and retry safely. This function never charges, reserves or refunds.
 */
export function getScheduledCheckoutNextAction(
  snapshot: ScheduledCheckoutSnapshot
): ScheduledCheckoutNextAction {
  if (!snapshot.orderId.trim()) return "manual_review";
  if (snapshot.paymentState === "not_started" || snapshot.paymentState === "failed") {
    return "retry_payment";
  }
  if (snapshot.paymentState !== "captured") return "manual_review";

  if (snapshot.inventoryState === "not_requested") {
    return "request_inventory_reservation";
  }
  if (snapshot.inventoryState === "reserved") {
    if (snapshot.alternativeChoice !== "not_required") return "manual_review";
    return "schedule_preparation_and_dispatch";
  }
  if (snapshot.inventoryState === "unavailable") {
    if (snapshot.alternatives.length > 0 && snapshot.alternativeChoice === "awaiting_customer") {
      return "await_customer_choice";
    }
    if (snapshot.alternativeChoice === "accepted") return "manual_review";
    if (snapshot.alternativeChoice === "declined" ||
        (snapshot.alternatives.length === 0 && snapshot.alternativeChoice === "not_required")) {
      return "process_refund";
    }
    if (snapshot.alternatives.length > 0 && snapshot.alternativeChoice === "not_required") {
      return "present_alternatives";
    }
  }
  return "manual_review";
}

export interface ScheduledFulfillmentTaskEnvelope {
  idempotencyKey: string;
  orderId: string;
  taskType: "merchant_reservation" | "merchant_preparation" | "courier_dispatch" | "shopper_collection";
  executeAtUtc: string;
  plan: ScheduledOrderPlan;
}

/** Build a stable provider/task idempotency key for a specific order action and version. */
export function scheduledFulfillmentIdempotencyKey(
  orderId: string,
  action: ScheduledFulfillmentTaskEnvelope["taskType"],
  version: number
): string | null {
  if (!orderId.trim() || !Number.isSafeInteger(version) || version < 1) return null;
  return `scheduled-fulfillment:${orderId}:${action}:v${version}`;
}

/**
 * Build timed fulfillment tasks only after the checkout saga has persisted a confirmed
 * exact-variant inventory reservation. The immediate reservation is a checkout action,
 * not a delayed preparation/dispatch task.
 */
export function buildScheduledFulfillmentTasks(
  plan: ScheduledOrderPlan,
  version: number
): readonly ScheduledFulfillmentTaskEnvelope[] {
  const tasks: ScheduledFulfillmentTaskEnvelope[] = [];

  if (plan.fulfillmentType === "personal_shopper_pickup") {
    tasks.push({
      idempotencyKey: scheduledFulfillmentIdempotencyKey(plan.orderId, "shopper_collection", version)!,
      orderId: plan.orderId,
      taskType: "shopper_collection",
      executeAtUtc: plan.preparationReleaseAtUtc,
      plan
    });
  } else {
    tasks.push({
      idempotencyKey: scheduledFulfillmentIdempotencyKey(plan.orderId, "merchant_preparation", version)!,
      orderId: plan.orderId,
      taskType: "merchant_preparation",
      executeAtUtc: plan.preparationReleaseAtUtc,
      plan
    });
  }

  if (plan.courierDispatchAtUtc) {
    tasks.push({
      idempotencyKey: scheduledFulfillmentIdempotencyKey(plan.orderId, "courier_dispatch", version)!,
      orderId: plan.orderId,
      taskType: "courier_dispatch",
      executeAtUtc: plan.courierDispatchAtUtc,
      plan
    });
  }
  return tasks;
}
