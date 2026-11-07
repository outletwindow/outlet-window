import { describe, expect, it } from "vitest";
import {
  commitScheduledOrderAndTasks,
  type ScheduledOrderCommitTransaction,
  type ScheduledOrderConfirmation,
  type ScheduledOrderTransactionRunner
} from "./scheduled-order-commit.js";
import type { ScheduledFulfillmentTaskEnvelope } from "./scheduled-fulfillment-workflow.js";
import type { ScheduledTaskOutboxRecord } from "./scheduled-task-outbox.js";

const order: ScheduledOrderConfirmation = {
  orderId: "order-1",
  tenantId: "tenant-1",
  paymentReference: "payment-provider-ref-1",
  paymentCapturedAtUtc: "2026-11-07T09:00:00.000Z",
  confirmedAtUtc: "2026-11-07T09:00:01.000Z",
  fulfillmentVersion: 1
};

const tasks: ScheduledFulfillmentTaskEnvelope[] = [{
  idempotencyKey: "scheduled-fulfillment:order-1:merchant_reservation:v1",
  orderId: "order-1",
  taskType: "merchant_reservation",
  executeAtUtc: "2026-11-07T09:00:01.000Z",
  plan: {
    orderId: "order-1",
    fulfillmentType: "store_pickup",
    scheduledFor: "2026-11-07T17:00:00+03:00",
    scheduledForUtc: "2026-11-07T14:00:00.000Z",
    paymentDueAt: "2026-11-07T09:00:00.000Z",
    inventoryReservationDueAt: "2026-11-07T09:00:00.000Z",
    preparationReleaseAtUtc: "2026-11-07T13:30:00.000Z",
    estimate: { preparationMinutes: 30, bufferMinutes: 0, travelMinutes: 0 },
    createdAt: "2026-11-07T09:00:00.000Z"
  }
}];

function createRunner(options: {
  duplicate?: boolean;
  failOnEnqueue?: boolean;
  failOnCommit?: boolean;
  events: string[];
}): ScheduledOrderTransactionRunner {
  return {
    async run<T>(work: (tx: ScheduledOrderCommitTransaction) => Promise<T>): Promise<T> {
      options.events.push("begin");
      try {
        const result = await work({
          async saveConfirmedOrder() { options.events.push("save_order"); },
          async enqueueOutbox(_record: ScheduledTaskOutboxRecord) {
            options.events.push("enqueue_outbox");
            if (options.failOnEnqueue) throw new Error("outbox_write_failed");
            return options.duplicate ? "already_exists" : "inserted";
          }
        });
        if (options.failOnCommit) throw new Error("commit_failed");
        options.events.push("commit");
        return result;
      } catch (error) {
        options.events.push("rollback");
        throw error;
      }
    }
  };
}

describe("atomic scheduled order and outbox commit", () => {
  it("saves the confirmed order and tasks in one transaction", async () => {
    const events: string[] = [];
    const result = await commitScheduledOrderAndTasks({
      order, tasks, outboxIdForTask: (_task, index) => `outbox-${index}`,
      transactionRunner: createRunner({ events })
    });
    expect(result).toEqual({
      status: "committed", orderId: "order-1", taskCount: 1, duplicateTaskCount: 0
    });
    expect(events).toEqual(["begin", "save_order", "enqueue_outbox", "commit"]);
  });

  it("does not write anything when the order/payment confirmation is invalid", async () => {
    const events: string[] = [];
    const result = await commitScheduledOrderAndTasks({
      order: { ...order, paymentReference: "" }, tasks,
      outboxIdForTask: () => "outbox-1",
      transactionRunner: createRunner({ events })
    });
    expect(result).toEqual({ status: "rejected", reason: "invalid_order" });
    expect(events).toEqual([]);
  });

  it("rejects missing, mismatched, or duplicate tasks before opening a transaction", async () => {
    const events: string[] = [];
    const runner = createRunner({ events });
    const empty = await commitScheduledOrderAndTasks({
      order, tasks: [], outboxIdForTask: () => "x", transactionRunner: runner
    });
    const mismatch = await commitScheduledOrderAndTasks({
      order, tasks: [{ ...tasks[0]!, orderId: "other" }],
      outboxIdForTask: () => "x", transactionRunner: runner
    });
    const duplicate = await commitScheduledOrderAndTasks({
      order, tasks: [tasks[0]!, tasks[0]!],
      outboxIdForTask: (_task, index) => `outbox-${index}`, transactionRunner: runner
    });
    expect(empty).toEqual({ status: "rejected", reason: "invalid_tasks" });
    expect(mismatch).toEqual({ status: "rejected", reason: "invalid_tasks" });
    expect(duplicate).toEqual({ status: "rejected", reason: "invalid_tasks" });
    expect(events).toEqual([]);
  });

  it("treats idempotent duplicate task insertion as a safe replay", async () => {
    const events: string[] = [];
    const result = await commitScheduledOrderAndTasks({
      order, tasks, outboxIdForTask: () => "outbox-1",
      transactionRunner: createRunner({ events, duplicate: true })
    });
    expect(result).toMatchObject({ status: "committed", duplicateTaskCount: 1 });
    expect(events.at(-1)).toBe("commit");
  });

  it("propagates adapter failures so the transaction runner can roll back all writes", async () => {
    const events: string[] = [];
    await expect(commitScheduledOrderAndTasks({
      order, tasks, outboxIdForTask: () => "outbox-1",
      transactionRunner: createRunner({ events, failOnEnqueue: true })
    })).rejects.toThrow("outbox_write_failed");
    expect(events).toEqual(["begin", "save_order", "enqueue_outbox", "rollback"]);
  });
});
