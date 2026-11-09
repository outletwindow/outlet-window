import type { InventoryReservationPort, InventoryReservationRequest, InventoryReservationResult } from "./inventory-reservation.js";
import { reserveInventoryForPaidOrder } from "./inventory-reservation.js";
import {
  buildScheduledFulfillmentTasks,
  type ScheduledFulfillmentTaskEnvelope
} from "./scheduled-fulfillment-workflow.js";
import {
  commitScheduledOrderAndTasks,
  type ScheduledOrderConfirmation,
  type ScheduledOrderTransactionRunner,
  type ScheduledPaymentCaptureRecorder,
  type ScheduledOrderCommitResult
} from "./scheduled-order-commit.js";
import type { ScheduledOrderPlan } from "./scheduled-fulfillment.js";

export interface ScheduledCheckoutRecoveryRecorder {
  record(input: {
    tenantId: string;
    orderId: string;
    idempotencyKey: string;
    failureCode: "INVENTORY_UNAVAILABLE" | "INVENTORY_UNGUARANTEED" | "TASK_COMMIT_REJECTED";
    failedSuborderId?: string;
    paymentReference: string;
    paymentCapturedAtUtc: string;
    reservationReferences: readonly { suborderId: string; reservationReference: string }[];
  }): Promise<{ outcome: "recorded" | "duplicate"; caseId: string } | { outcome: "identity_collision" }>;
}

export type ScheduledCheckoutRecoveryStatus =
  | { status: "recorded" | "duplicate"; caseId: string }
  | { status: "not_configured" }
  | { status: "persistence_failed" }
  | { status: "identity_collision" };

async function recordRecoveryCase(input: {
  recorder?: ScheduledCheckoutRecoveryRecorder;
  order: ScheduledOrderConfirmation;
  failureCode: "INVENTORY_UNAVAILABLE" | "INVENTORY_UNGUARANTEED" | "TASK_COMMIT_REJECTED";
  failedSuborderId?: string;
  reservationReferences: readonly { suborderId: string; reservationReference: string }[];
}): Promise<ScheduledCheckoutRecoveryStatus> {
  if (!input.recorder) return { status: "not_configured" };
  try {
    const result = await input.recorder.record({
      tenantId: input.order.tenantId,
      orderId: input.order.orderId,
      idempotencyKey: "checkout-recovery:" + input.order.orderId + ":" + input.order.fulfillmentVersion,
      failureCode: input.failureCode,
      ...(input.failedSuborderId === undefined ? {} : { failedSuborderId: input.failedSuborderId }),
      paymentReference: input.order.paymentReference,
      paymentCapturedAtUtc: input.order.paymentCapturedAtUtc,
      reservationReferences: input.reservationReferences
    });
    return result.outcome === "identity_collision"
      ? { status: "identity_collision" }
      : { status: result.outcome, caseId: result.caseId };
  } catch {
    return { status: "persistence_failed" };
  }
}


export type ScheduledCheckoutOrchestrationResult =
  | {
      status: "scheduled";
      orderId: string;
      paymentCapture: "inserted" | "already_exists";
      reservationReferences: readonly { suborderId: string; reservationReference: string }[];
      taskCommit: Extract<ScheduledOrderCommitResult, { status: "committed" }>;
    }
  | {
      status: "inventory_unavailable" | "inventory_unguaranteed";
      orderId: string;
      paymentCapture: "inserted" | "already_exists";
      failedSuborderId: string;
      inventoryResult: InventoryReservationResult;
      reservationReferences: readonly { suborderId: string; reservationReference: string }[];
      recoveryCase?: ScheduledCheckoutRecoveryStatus;
    }
  | {
      status: "task_commit_rejected";
      orderId: string;
      paymentCapture: "inserted" | "already_exists";
      reason: "invalid_order" | "invalid_tasks";
      reservationReferences: readonly { suborderId: string; reservationReference: string }[];
      recoveryCase?: ScheduledCheckoutRecoveryStatus;
    }
  | { status: "rejected"; reason: "invalid_checkout_input" };

/**
 * Executes the post-payment scheduled checkout sequence:
 * persist verified capture evidence -> reserve each exact merchant suborder -> enqueue timed tasks.
 * It never charges, refunds, substitutes, or releases a successful reservation automatically.
 * If a later suborder is unavailable, earlier holds are returned to the caller for an explicit
 * customer-choice/compensation workflow; no preparation or dispatch tasks are enqueued.
 */
export async function orchestratePaidScheduledCheckout(input: {
  order: ScheduledOrderConfirmation;
  /** Legacy shared plan; use planForSuborder when merchant branches have different timings. */
  plan: ScheduledOrderPlan;
  /** Resolve a persisted, branch-specific schedule for each merchant suborder before payment evidence is recorded. */
  planForSuborder?: (request: InventoryReservationRequest) => ScheduledOrderPlan;
  inventoryRequests: readonly InventoryReservationRequest[];
  paymentCaptureRecorder: ScheduledPaymentCaptureRecorder;
  inventoryPort: InventoryReservationPort;
  transactionRunner: ScheduledOrderTransactionRunner;
  outboxIdForTask: (task: ScheduledFulfillmentTaskEnvelope, index: number) => string;
  /** Persist a durable customer/refund-resolution case after a paid checkout cannot be completed. */
  recoveryRecorder?: ScheduledCheckoutRecoveryRecorder;
}): Promise<ScheduledCheckoutOrchestrationResult> {
  const { order, plan, inventoryRequests } = input;
  if (!order.orderId.trim() || plan.orderId !== order.orderId ||
      inventoryRequests.length === 0 ||
      inventoryRequests.some(request => request.orderId !== order.orderId ||
        !request.suborderId.trim() || !request.tenantId.trim() ||
        !request.merchantId.trim() || !request.branchId.trim()) ||
      new Set(inventoryRequests.map(request => request.suborderId)).size !== inventoryRequests.length) {
    return { status: "rejected", reason: "invalid_checkout_input" };
  }

  // Resolve every merchant schedule before recording payment evidence. This prevents a
  // late schedule-resolution failure after capture and avoids imposing one branch timing
  // on every merchant in a multi-store order.
  const plansBySuborder = new Map<string, ScheduledOrderPlan>();
  try {
    for (const request of inventoryRequests) {
      const suborderPlan = input.planForSuborder?.(request) ?? plan;
      if (suborderPlan.orderId !== order.orderId ||
          !Number.isFinite(Date.parse(suborderPlan.preparationReleaseAtUtc)) ||
          (suborderPlan.courierDispatchAtUtc !== undefined &&
            !Number.isFinite(Date.parse(suborderPlan.courierDispatchAtUtc)))) {
        return { status: "rejected", reason: "invalid_checkout_input" };
      }
      plansBySuborder.set(request.suborderId, suborderPlan);
    }
  } catch {
    return { status: "rejected", reason: "invalid_checkout_input" };
  }

  const paymentCapture = await input.paymentCaptureRecorder.recordPaymentCapture(order);
  const reservationReferences: { suborderId: string; reservationReference: string }[] = [];
  const tasks: ScheduledFulfillmentTaskEnvelope[] = [];

  const orderedRequests = [...inventoryRequests].sort((a, b) => a.suborderId.localeCompare(b.suborderId));
  for (const request of orderedRequests) {
    const inventoryResult = await reserveInventoryForPaidOrder({
      paymentCaptured: true,
      request,
      port: input.inventoryPort
    });
    if (inventoryResult.state !== "reserved") {
      const failureCode = inventoryResult.state === "unavailable"
        ? "INVENTORY_UNAVAILABLE" as const : "INVENTORY_UNGUARANTEED" as const;
      const recoveryCase = await recordRecoveryCase({
        recorder: input.recoveryRecorder, order, failureCode,
        failedSuborderId: request.suborderId, reservationReferences
      });
      return {
        status: inventoryResult.state === "unavailable" ? "inventory_unavailable" : "inventory_unguaranteed",
        orderId: order.orderId,
        paymentCapture,
        failedSuborderId: request.suborderId,
        inventoryResult,
        reservationReferences,
        recoveryCase
      };
    }
    reservationReferences.push({
      suborderId: request.suborderId,
      reservationReference: inventoryResult.reservationReference
    });
    tasks.push(...buildScheduledFulfillmentTasks(plansBySuborder.get(request.suborderId)!, order.fulfillmentVersion, {
      merchantTenantId: request.tenantId,
      suborderId: request.suborderId,
      merchantId: request.merchantId,
      branchId: request.branchId
    }));
  }

  const taskCommit = await commitScheduledOrderAndTasks({
    order,
    tasks,
    outboxIdForTask: input.outboxIdForTask,
    transactionRunner: input.transactionRunner
  });
  if (taskCommit.status !== "committed") {
    const recoveryCase = await recordRecoveryCase({
      recorder: input.recoveryRecorder, order, failureCode: "TASK_COMMIT_REJECTED",
      reservationReferences
    });
    return {
      status: "task_commit_rejected",
      orderId: order.orderId,
      paymentCapture,
      reason: taskCommit.reason,
      reservationReferences,
      recoveryCase
    };
  }
  return {
    status: "scheduled",
    orderId: order.orderId,
    paymentCapture,
    reservationReferences,
    taskCommit
  };
}
