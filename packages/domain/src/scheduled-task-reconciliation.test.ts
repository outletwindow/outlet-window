import { describe, expect, it } from "vitest";
import {
  reconcileScheduledOrderTasks,
  type ScheduledTaskReconciliationIssue
} from "./scheduled-task-reconciliation.js";
import type { ScheduledFulfillmentTaskEnvelope } from "./scheduled-fulfillment-workflow.js";
import type { ScheduledTaskOutboxRecord } from "./scheduled-task-outbox.js";

const task: ScheduledFulfillmentTaskEnvelope = {
  idempotencyKey: "scheduled-fulfillment:order-1:merchant_reservation:v1",
  orderId: "order-1",
  taskType: "merchant_reservation",
  executeAtUtc: "2026-11-07T09:00:00.000Z",
  plan: {
    orderId: "order-1", fulfillmentType: "store_pickup",
    scheduledFor: "2026-11-07T17:00:00+03:00",
    scheduledForUtc: "2026-11-07T14:00:00.000Z",
    paymentDueAt: "2026-11-07T09:00:00.000Z",
    inventoryReservationDueAt: "2026-11-07T09:00:00.000Z",
    preparationReleaseAtUtc: "2026-11-07T13:30:00.000Z",
    estimate: { preparationMinutes: 30, bufferMinutes: 0, travelMinutes: 0 },
    createdAt: "2026-11-07T09:00:00.000Z"
  }
};

function record(overrides: Partial<ScheduledTaskOutboxRecord> = {}): ScheduledTaskOutboxRecord {
  return {
    id: "outbox-1", idempotencyKey: task.idempotencyKey, orderId: "order-1",
    taskType: task.taskType, executeAtUtc: task.executeAtUtc, status: "pending",
    attemptCount: 0, createdAtUtc: "2026-11-07T09:00:00.000Z",
    updatedAtUtc: "2026-11-07T09:00:00.000Z",
    availableAtUtc: "2026-11-07T09:00:00.000Z", ...overrides
  };
}

describe("scheduled task reconciliation", () => {
  it("reports a healthy order when its expected task is persisted", () => {
    const result = reconcileScheduledOrderTasks({
      orderId: "order-1", expectedTasks: [task], persistedRecords: [record()],
      nowUtc: "2026-11-07T09:01:00.000Z"
    });
    expect(result?.healthy).toBe(true);
    expect(result?.issues).toEqual([]);
  });

  it("detects a missing expected task", () => {
    const result = reconcileScheduledOrderTasks({
      orderId: "order-1", expectedTasks: [task], persistedRecords: [],
      nowUtc: "2026-11-07T09:01:00.000Z"
    });
    expect(result?.issues).toContainEqual({
      type: "missing_task", idempotencyKey: task.idempotencyKey, severity: "critical"
    });
  });

  it("detects duplicates, dead letters, expired leases and stale pending tasks", () => {
    const issues = reconcileScheduledOrderTasks({
      orderId: "order-1", expectedTasks: [task],
      persistedRecords: [
        record({ id: "one", status: "dead_letter" }),
        record({ id: "two", status: "leased", leaseToken: "lease", leaseExpiresAtUtc: "2026-11-07T08:59:00.000Z" }),
        record({ id: "three", status: "pending" })
      ],
      nowUtc: "2026-11-07T09:10:00.000Z", pendingStaleAfterSeconds: 60
    })?.issues ?? [];
    const types = issues.map(issue => issue.type);
    expect(types).toContain("duplicate_task");
    expect(types).toContain("dead_letter");
    expect(types).toContain("expired_lease");
    expect(types).toContain("stale_pending");
  });

  it("detects unexpected records and rejects cross-order records", () => {
    const unexpected = record({ id: "extra", idempotencyKey: "unexpected:key" });
    expect(reconcileScheduledOrderTasks({
      orderId: "order-1", expectedTasks: [task], persistedRecords: [unexpected],
      nowUtc: "2026-11-07T09:01:00.000Z"
    })?.issues.map(issue => issue.type)).toContain("unexpected_task");

    expect(reconcileScheduledOrderTasks({
      orderId: "order-1", expectedTasks: [task],
      persistedRecords: [record({ orderId: "other-order" })],
      nowUtc: "2026-11-07T09:01:00.000Z"
    })).toBeNull();
  });

  it("rejects malformed reconciliation input", () => {
    expect(reconcileScheduledOrderTasks({
      orderId: " ", expectedTasks: [task], persistedRecords: [],
      nowUtc: "2026-11-07T09:01:00.000Z"
    })).toBeNull();
    expect(reconcileScheduledOrderTasks({
      orderId: "order-1", expectedTasks: [task], persistedRecords: [],
      nowUtc: "invalid"
    })).toBeNull();
  });
});
