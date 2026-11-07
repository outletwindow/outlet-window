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
    if (snapshot.alternativeChoice === "accepted") {
      return "manual_review";
    }
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
  taskType: "merchant_reservation" | "preparation" | "courier_dispatch" | "shopper_collection";
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
