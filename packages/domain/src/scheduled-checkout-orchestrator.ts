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
    }
  | {
      status: "task_commit_rejected";
      orderId: string;
      paymentCapture: "inserted" | "already_exists";
      reason: "invalid_order" | "invalid_tasks";
      reservationReferences: readonly { suborderId: string; reservationReference: string }[];
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
  plan: ScheduledOrderPlan;
  inventoryRequests: readonly InventoryReservationRequest[];
  paymentCaptureRecorder: ScheduledPaymentCaptureRecorder;
  inventoryPort: InventoryReservationPort;
  transactionRunner: ScheduledOrderTransactionRunner;
  outboxIdForTask: (task: ScheduledFulfillmentTaskEnvelope, index: number) => string;
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
      return {
        status: inventoryResult.state === "unavailable" ? "inventory_unavailable" : "inventory_unguaranteed",
        orderId: order.orderId,
        paymentCapture,
        failedSuborderId: request.suborderId,
        inventoryResult,
        reservationReferences
      };
    }
    reservationReferences.push({
      suborderId: request.suborderId,
      reservationReference: inventoryResult.reservationReference
    });
    tasks.push(...buildScheduledFulfillmentTasks(plan, order.fulfillmentVersion, {
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
    return {
      status: "task_commit_rejected",
      orderId: order.orderId,
      paymentCapture,
      reason: taskCommit.reason,
      reservationReferences
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
