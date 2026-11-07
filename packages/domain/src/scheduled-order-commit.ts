import type { ScheduledFulfillmentTaskEnvelope } from "./scheduled-fulfillment-workflow.js";
import {
  createScheduledTaskOutboxRecord,
  type ScheduledTaskOutboxRecord
} from "./scheduled-task-outbox.js";

export interface ScheduledOrderConfirmation {
  orderId: string;
  tenantId: string;
  paymentReference: string;
  paymentCapturedAtUtc: string;
  confirmedAtUtc: string;
  fulfillmentVersion: number;
}

export interface ScheduledOrderCommitTransaction {
  /** Persist the confirmed order inside the transaction. */
  saveConfirmedOrder(order: ScheduledOrderConfirmation): Promise<void>;
  /** Insert by unique idempotencyKey; return already_exists for a safe replay. */
  enqueueOutbox(record: ScheduledTaskOutboxRecord): Promise<"inserted" | "already_exists">;
}

export interface ScheduledOrderTransactionRunner {
  /** The adapter must commit all callback writes atomically or roll all of them back. */
  run<T>(work: (transaction: ScheduledOrderCommitTransaction) => Promise<T>): Promise<T>;
}

export interface CommitScheduledOrderInput {
  order: ScheduledOrderConfirmation;
  tasks: readonly ScheduledFulfillmentTaskEnvelope[];
  outboxIdForTask: (task: ScheduledFulfillmentTaskEnvelope, index: number) => string;
  transactionRunner: ScheduledOrderTransactionRunner;
}

export type ScheduledOrderCommitResult =
  | { status: "committed"; orderId: string; taskCount: number; duplicateTaskCount: number }
  | { status: "rejected"; reason: "invalid_order" | "invalid_tasks" };

/**
 * Atomically stores an already-paid scheduled order and its outbox tasks.
 * Payment capture itself must happen through the approved payment adapter before this call.
 * This function does not provide a database transaction implementation.
 */
export async function commitScheduledOrderAndTasks(
  input: CommitScheduledOrderInput
): Promise<ScheduledOrderCommitResult> {
  const { order, tasks } = input;
  const capturedAt = Date.parse(order.paymentCapturedAtUtc);
  const confirmedAt = Date.parse(order.confirmedAtUtc);
  if (
    !order.orderId.trim() ||
    !order.tenantId.trim() ||
    !order.paymentReference.trim() ||
    !Number.isFinite(capturedAt) ||
    !Number.isFinite(confirmedAt) ||
    confirmedAt < capturedAt ||
    !Number.isSafeInteger(order.fulfillmentVersion) ||
    order.fulfillmentVersion < 1
  ) return { status: "rejected", reason: "invalid_order" };

  if (
    tasks.length === 0 ||
    tasks.some(task => task.orderId !== order.orderId || task.plan.orderId !== order.orderId) ||
    new Set(tasks.map(task => task.idempotencyKey)).size !== tasks.length ||
    tasks.some(task => !task.idempotencyKey.trim())
  ) return { status: "rejected", reason: "invalid_tasks" };

  const records = tasks.map((task, index) => createScheduledTaskOutboxRecord({
    id: input.outboxIdForTask(task, index),
    task,
    nowUtc: order.confirmedAtUtc
  }));
  if (records.some(record => record === null)) {
    return { status: "rejected", reason: "invalid_tasks" };
  }

  return input.transactionRunner.run(async transaction => {
    await transaction.saveConfirmedOrder(order);
    let duplicateTaskCount = 0;
    for (const record of records) {
      const result = await transaction.enqueueOutbox(record!);
      if (result === "already_exists") duplicateTaskCount += 1;
    }
    return {
      status: "committed" as const,
      orderId: order.orderId,
      taskCount: records.length,
      duplicateTaskCount
    };
  });
}
