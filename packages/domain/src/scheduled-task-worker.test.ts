import { describe, expect, it } from "vitest";
import {
  runScheduledTaskBatch,
  ScheduledTaskPublishError,
  type ScheduledTaskPublisher
} from "./scheduled-task-worker.js";
import type { ScheduledTaskOutboxRecord, ScheduledTaskOutboxStore } from "./scheduled-task-outbox.js";
import type { ScheduledFulfillmentTaskEnvelope } from "./scheduled-fulfillment-workflow.js";

const task: ScheduledFulfillmentTaskEnvelope = {
  idempotencyKey: "scheduled-fulfillment:worker-order:merchant_reservation:v1",
  orderId: "worker-order", taskType: "merchant_reservation",
  executeAtUtc: "2026-11-08T10:00:00.000Z",
  plan: {
    orderId: "worker-order", fulfillmentType: "store_pickup",
    scheduledFor: "2026-11-08T13:00:00+03:00",
    scheduledForUtc: "2026-11-08T10:00:00.000Z",
    paymentDueAt: "2026-11-08T09:00:00.000Z",
    inventoryReservationDueAt: "2026-11-08T10:00:00.000Z",
    preparationReleaseAtUtc: "2026-11-08T11:00:00.000Z",
    estimate: { preparationMinutes: 60, bufferMinutes: 0, travelMinutes: 0 },
    createdAt: "2026-11-08T09:00:00.000Z"
  }
};
function createRecord(overrides: Partial<ScheduledTaskOutboxRecord> = {}): ScheduledTaskOutboxRecord {
  return {
    id: "outbox-worker-1", idempotencyKey: task.idempotencyKey,
    orderId: task.orderId, taskType: task.taskType, executeAtUtc: task.executeAtUtc,
    status: "leased", attemptCount: 1, createdAtUtc: "2026-11-08T09:00:00.000Z",
    updatedAtUtc: "2026-11-08T09:59:00.000Z", availableAtUtc: "2026-11-08T10:00:00.000Z",
    leaseToken: "batch:outbox-worker-1", leaseExpiresAtUtc: "2026-11-08T10:01:00.000Z",
    payload: task, ...overrides
  };
}
function createStore(record: ScheduledTaskOutboxRecord) {
  const calls: string[] = [];
  const store: ScheduledTaskOutboxStore = {
    async enqueue() { return "inserted"; },
    async claimDue(input) { calls.push("claim:" + input.limit); return [record]; },
    async markPublished(input) { calls.push("published:" + input.leaseToken); return true; },
    async retry(input) { calls.push("retry:" + input.errorCode); return true; },
    async deadLetter(input) { calls.push("dead:" + input.errorCode); return true; }
  };
  return { store, calls };
}
const base = {
  nowUtc: "2026-11-08T10:00:00.000Z",
  leaseToken: "batch",
  publisher: { async publish() {} } satisfies ScheduledTaskPublisher
};

describe("scheduled task worker", () => {
  it("publishes a valid task and acknowledges it with its lease token", async () => {
    const { store, calls } = createStore(createRecord());
    let publishedKey = "";
    const result = await runScheduledTaskBatch({
      ...base, store,
      publisher: { async publish(_task, key) { publishedKey = key; } }
    });
    expect(result).toEqual({ claimed: 1, published: 1, retried: 0, deadLettered: 0, leaseLost: 0 });
    expect(publishedKey).toBe(task.idempotencyKey);
    expect(calls).toContain("published:batch:outbox-worker-1");
  });

  it("schedules a bounded retry after a transient publisher failure", async () => {
    const { store, calls } = createStore(createRecord());
    const result = await runScheduledTaskBatch({
      ...base, store,
      publisher: { async publish() { throw new ScheduledTaskPublishError("TEMPORARY_DOWN"); } }
    });
    expect(result.retried).toBe(1);
    expect(calls).toContain("retry:TEMPORARY_DOWN");
  });

  it("moves permanent failures and exhausted attempts to dead letter", async () => {
    const permanent = createStore(createRecord());
    const permanentResult = await runScheduledTaskBatch({
      ...base, store: permanent.store,
      publisher: { async publish() { throw new ScheduledTaskPublishError("INVALID_TARGET", false); } }
    });
    expect(permanentResult.deadLettered).toBe(1);

    const exhausted = createStore(createRecord({ attemptCount: 8 }));
    const exhaustedResult = await runScheduledTaskBatch({
      ...base, store: exhausted.store,
      publisher: { async publish() { throw new Error("temporary"); } }
    });
    expect(exhaustedResult.deadLettered).toBe(1);
  });

  it("dead-letters payloads that do not match their persisted envelope", async () => {
    const { store, calls } = createStore(createRecord({
      payload: { ...task, orderId: "different-order" }
    }));
    const result = await runScheduledTaskBatch({ ...base, store });
    expect(result.deadLettered).toBe(1);
    expect(calls).toContain("dead:INVALID_TASK_PAYLOAD");
  });

  it("does not publish when the lease is already expired", async () => {
    const { store } = createStore(createRecord({ leaseExpiresAtUtc: "2026-11-08T09:59:59.000Z" }));
    let publishCalls = 0;
    const result = await runScheduledTaskBatch({
      ...base, store, publisher: { async publish() { publishCalls += 1; } }
    });
    expect(publishCalls).toBe(0);
    expect(result.leaseLost).toBe(1);
  });
});
