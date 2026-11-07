import {
  isScheduledTaskLeaseValid,
  scheduledTaskRetryAtUtc,
  type ScheduledTaskOutboxRecord,
  type ScheduledTaskOutboxStore
} from "./scheduled-task-outbox.js";
import type { ScheduledFulfillmentTaskEnvelope } from "./scheduled-fulfillment-workflow.js";

export interface ScheduledTaskPublisher {
  /** Consumers must use idempotencyKey to make at-least-once delivery safe. */
  publish(task: ScheduledFulfillmentTaskEnvelope, idempotencyKey: string): Promise<void>;
}

export class ScheduledTaskPublishError extends Error {
  constructor(readonly code: string, readonly retryable = true) {
    super(code);
    this.name = "ScheduledTaskPublishError";
  }
}

export interface ScheduledTaskWorkerResult {
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
  leaseLost: number;
}

function safeErrorCode(error: unknown): string {
  const code = error instanceof ScheduledTaskPublishError ? error.code : "PUBLISH_FAILED";
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : "PUBLISH_FAILED";
}

/** Processes one bounded batch. It never performs payment, refund, or inventory mutations itself. */
export async function runScheduledTaskBatch(input: {
  store: ScheduledTaskOutboxStore;
  publisher: ScheduledTaskPublisher;
  nowUtc: string;
  leaseToken: string;
  leaseDurationSeconds?: number;
  limit?: number;
  maxAttempts?: number;
  baseDelaySeconds?: number;
  maxDelaySeconds?: number;
}): Promise<ScheduledTaskWorkerResult> {
  const now = Date.parse(input.nowUtc);
  const maxAttempts = input.maxAttempts ?? 8;
  if (!Number.isFinite(now) || !input.leaseToken.trim() ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new Error("invalid_scheduled_task_worker_input");
  }
  const records = await input.store.claimDue({
    nowUtc: new Date(now).toISOString(),
    leaseToken: input.leaseToken,
    leaseDurationSeconds: input.leaseDurationSeconds ?? 60,
    limit: input.limit ?? 10
  });
  const result: ScheduledTaskWorkerResult = {
    claimed: records.length, published: 0, retried: 0, deadLettered: 0, leaseLost: 0
  };

  for (const record of records) {
    const leaseToken = record.leaseToken ?? "";
    if (!isScheduledTaskLeaseValid({ record, leaseToken, nowUtc: new Date(now).toISOString() })) {
      result.leaseLost += 1;
      continue;
    }
    try {
      await input.publisher.publish(record.payload, record.idempotencyKey);
      const acknowledged = await input.store.markPublished({
        id: record.id, leaseToken, publishedAtUtc: new Date(now).toISOString()
      });
      if (acknowledged) result.published += 1;
      else result.leaseLost += 1;
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const permanent = error instanceof ScheduledTaskPublishError && !error.retryable;
      if (permanent || record.attemptCount >= maxAttempts) {
        const moved = await input.store.deadLetter({
          id: record.id, leaseToken, nowUtc: new Date(now).toISOString(), errorCode
        });
        if (moved) result.deadLettered += 1;
        else result.leaseLost += 1;
        continue;
      }
      const retryAt = scheduledTaskRetryAtUtc({
        nowUtc: new Date(now).toISOString(),
        attemptCount: record.attemptCount,
        baseDelaySeconds: input.baseDelaySeconds,
        maxDelaySeconds: input.maxDelaySeconds
      });
      if (!retryAt) throw new Error("scheduled_task_retry_time_invalid");
      const retried = await input.store.retry({
        id: record.id, leaseToken, availableAtUtc: retryAt,
        nowUtc: new Date(now).toISOString(), errorCode
      });
      if (retried) result.retried += 1;
      else result.leaseLost += 1;
    }
  }
  return result;
}

/** Type guard useful to adapters that inspect a claimed record before publishing. */
export function isScheduledTaskPayload(record: ScheduledTaskOutboxRecord): boolean {
  return record.payload.orderId === record.orderId &&
    record.payload.idempotencyKey === record.idempotencyKey &&
    record.payload.taskType === record.taskType &&
    record.payload.executeAtUtc === record.executeAtUtc;
}
