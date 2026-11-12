import { describe, expect, it } from "vitest";
import {
  runScheduledTaskInboxBatch,
  ScheduledTaskConsumeError,
  type ScheduledTaskInboxRecord,
  type ScheduledTaskInboxStore,
  type ScheduledTaskConsumerHandlers
} from "./scheduled-task-inbox.js";

const task = {
  idempotencyKey: "scheduled-fulfillment:parent:suborder:sub-1:merchant_preparation:v1",
  orderId: "parent",
  taskType: "merchant_preparation" as const,
  executeAtUtc: "2026-11-08T10:00:00.000Z",
  plan: {
    orderId: "parent", fulfillmentType: "store_pickup" as const,
    scheduledFor: "2026-11-08T13:00:00+03:00",
    scheduledForUtc: "2026-11-08T10:00:00.000Z",
    paymentDueAt: "2026-11-08T09:00:00.000Z",
    inventoryReservationDueAt: "2026-11-08T09:00:00.000Z",
    preparationReleaseAtUtc: "2026-11-08T10:00:00.000Z",
    estimate: { preparationMinutes: 60, bufferMinutes: 0, travelMinutes: 0 },
    createdAt: "2026-11-08T09:00:00.000Z"
  },
  target: {
    merchantTenantId: "merchant-tenant",
    suborderId: "sub-1",
    merchantId: "merchant-1",
    branchId: "branch-1"
  }
};

function record(overrides: Partial<ScheduledTaskInboxRecord> = {}): ScheduledTaskInboxRecord {
  return {
    id: "inbox-1", tenantId: "platform", orderId: task.orderId,
    idempotencyKey: task.idempotencyKey, taskType: task.taskType,
    payload: task, status: "processing", attemptCount: 1,
    createdAtUtc: "2026-11-08T09:00:00.000Z",
    updatedAtUtc: "2026-11-08T09:59:00.000Z",
    availableAtUtc: "2026-11-08T10:00:00.000Z",
    leaseToken: "batch:inbox-1",
    leaseExpiresAtUtc: "2026-11-08T10:01:00.000Z",
    ...overrides
  };
}

function storeFor(item: ScheduledTaskInboxRecord) {
  const calls: string[] = [];
  const completed: Array<{ providerReference?: string }> = [];
  const store: ScheduledTaskInboxStore = {
    async claimDue(input) { calls.push("claim:" + input.limit); return [item]; },
    async complete(input) { calls.push("complete:" + input.leaseToken); completed.push(input.providerReference === undefined ? {} : { providerReference: input.providerReference }); return true; },
    async retry(input) { calls.push("retry:" + input.errorCode); return true; },
    async deadLetter(input) { calls.push("dead:" + input.errorCode); return true; }
  };
  return { store, calls, completed };
}

const base = {
  nowUtc: "2026-11-08T10:00:00.000Z",
  leaseToken: "batch"
};

describe("scheduled task inbox worker", () => {
  it("dispatches a targeted task and acknowledges it with its lease token", async () => {
    const h = storeFor(record());
    const handled: string[] = [];
    const handlers: ScheduledTaskConsumerHandlers = {
      merchant_preparation: {
        async handle(_value, key) { handled.push(key); }
      }
    };
    const result = await runScheduledTaskInboxBatch({ ...base, ...h, handlers });
    expect(result).toEqual({ claimed: 1, completed: 1, retried: 0, deadLettered: 0, leaseLost: 0 });
    expect(handled).toEqual([task.idempotencyKey]);
    expect(h.calls).toContain("complete:batch:inbox-1");
  });

  it("persists a provider receipt as part of lease completion", async () => {
    const h = storeFor(record());
    const handlers: ScheduledTaskConsumerHandlers = {
      merchant_preparation: {
        async handle() { return { providerReference: "merchant-job-42" }; }
      }
    };
    const result = await runScheduledTaskInboxBatch({ ...base, ...h, handlers });
    expect(result.completed).toBe(1);
    expect(h.completed).toEqual([{ providerReference: "merchant-job-42" }]);
  });

  it("retries transient consumer failures with bounded backoff", async () => {
    const h = storeFor(record());
    const handlers: ScheduledTaskConsumerHandlers = {
      merchant_preparation: {
        async handle() { throw new ScheduledTaskConsumeError("MERCHANT_API_DOWN"); }
      }
    };
    const result = await runScheduledTaskInboxBatch({ ...base, ...h, handlers });
    expect(result.retried).toBe(1);
    expect(h.calls).toContain("retry:MERCHANT_API_DOWN");
  });

  it("dead-letters permanent failures and tasks without a configured handler", async () => {
    const permanent = storeFor(record());
    const permanentHandlers: ScheduledTaskConsumerHandlers = {
      merchant_preparation: {
        async handle() { throw new ScheduledTaskConsumeError("BRANCH_NOT_AUTHORIZED", false); }
      }
    };
    const permanentResult = await runScheduledTaskInboxBatch({
      ...base, ...permanent, handlers: permanentHandlers
    });
    expect(permanentResult.deadLettered).toBe(1);

    const missing = storeFor(record());
    const missingResult = await runScheduledTaskInboxBatch({
      ...base, ...missing, handlers: {}
    });
    expect(missingResult.deadLettered).toBe(1);
    expect(missing.calls).toContain("dead:NO_CONSUMER_HANDLER");
  });

  it("dead-letters malformed merchant targets and rejects stale leases", async () => {
    const malformed = storeFor(record({
      payload: { ...task, target: { ...task.target, branchId: "" } }
    }));
    const malformedResult = await runScheduledTaskInboxBatch({
      ...base, ...malformed, handlers: {}
    });
    expect(malformedResult.deadLettered).toBe(1);
    expect(malformed.calls).toContain("dead:INVALID_TASK_PAYLOAD");

    const stale = storeFor(record({ leaseExpiresAtUtc: "2026-11-08T09:59:59.000Z" }));
    const staleResult = await runScheduledTaskInboxBatch({
      ...base, ...stale, handlers: {}
    });
    expect(staleResult.leaseLost).toBe(1);
    expect(stale.calls).toEqual(["claim:10"]);
  });
});
