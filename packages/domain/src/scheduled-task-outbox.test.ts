import { describe, expect, it } from "vitest";
import {
  createScheduledTaskOutboxRecord,
  isScheduledTaskLeaseValid,
  scheduledTaskRetryAtUtc,
  type ScheduledTaskOutboxRecord
} from "./scheduled-task-outbox.js";

const task = {
  idempotencyKey: "scheduled-fulfillment:order-1:merchant_preparation:v1",
  orderId: "order-1",
  taskType: "merchant_preparation" as const,
  executeAtUtc: "2026-11-07T13:30:00.000Z",
  plan: {
    orderId: "order-1",
    fulfillmentType: "store_pickup" as const,
    scheduledFor: "2026-11-07T17:00:00+03:00",
    scheduledForUtc: "2026-11-07T14:00:00.000Z",
    paymentDueAt: "2026-11-07T09:00:00.000Z",
    inventoryReservationDueAt: "2026-11-07T09:00:00.000Z",
    preparationReleaseAtUtc: "2026-11-07T13:30:00.000Z",
    estimate: { preparationMinutes: 30, bufferMinutes: 0, travelMinutes: 0 },
    createdAt: "2026-11-07T09:00:00.000Z"
  }
};

describe("scheduled task outbox contracts", () => {
  it("creates a pending record and does not make it available before its due time", () => {
    const record = createScheduledTaskOutboxRecord({
      id: "outbox-1", task, nowUtc: "2026-11-07T12:00:00.000Z"
    });
    expect(record?.status).toBe("pending");
    expect(record?.attemptCount).toBe(0);
    expect(record?.availableAtUtc).toBe(task.executeAtUtc);
  });

  it("makes immediate tasks available immediately", () => {
    const record = createScheduledTaskOutboxRecord({
      id: "outbox-2", task: { ...task, executeAtUtc: "2026-11-07T11:00:00.000Z" },
      nowUtc: "2026-11-07T12:00:00.000Z"
    });
    expect(record?.availableAtUtc).toBe("2026-11-07T12:00:00.000Z");
  });

  it("rejects malformed records and order/plan mismatches", () => {
    expect(createScheduledTaskOutboxRecord({ id: " ", task, nowUtc: "bad" })).toBeNull();
    expect(createScheduledTaskOutboxRecord({
      id: "outbox-3", task: { ...task, orderId: "other-order" },
      nowUtc: "2026-11-07T12:00:00.000Z"
    })).toBeNull();
  });

  it("calculates bounded exponential retry times", () => {
    const input = { nowUtc: "2026-11-07T12:00:00.000Z", attemptCount: 1 };
    expect(scheduledTaskRetryAtUtc(input)).toBe("2026-11-07T12:00:15.000Z");
    expect(scheduledTaskRetryAtUtc({ ...input, attemptCount: 3 })).toBe("2026-11-07T12:01:00.000Z");
    expect(scheduledTaskRetryAtUtc({ ...input, attemptCount: 20 })).toBe("2026-11-07T12:15:00.000Z");
    expect(scheduledTaskRetryAtUtc({ ...input, attemptCount: 0 })).toBeNull();
  });

  it("requires a matching, unexpired lease before worker actions", () => {
    const record: ScheduledTaskOutboxRecord = {
      id: "outbox-4", idempotencyKey: task.idempotencyKey, orderId: task.orderId,
      taskType: task.taskType, executeAtUtc: task.executeAtUtc, status: "leased",
      attemptCount: 1, createdAtUtc: "2026-11-07T12:00:00.000Z",
      updatedAtUtc: "2026-11-07T12:00:00.000Z", availableAtUtc: "2026-11-07T12:00:00.000Z",
      leaseToken: "lease-1", leaseExpiresAtUtc: "2026-11-07T12:01:00.000Z"
    };
    expect(isScheduledTaskLeaseValid({
      record, leaseToken: "lease-1", nowUtc: "2026-11-07T12:00:30.000Z"
    })).toBe(true);
    expect(isScheduledTaskLeaseValid({
      record, leaseToken: "wrong", nowUtc: "2026-11-07T12:00:30.000Z"
    })).toBe(false);
    expect(isScheduledTaskLeaseValid({
      record, leaseToken: "lease-1", nowUtc: "2026-11-07T12:02:00.000Z"
    })).toBe(false);
  });
});
