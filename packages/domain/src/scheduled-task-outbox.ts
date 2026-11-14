import type { ScheduledFulfillmentTaskEnvelope } from "./scheduled-fulfillment-workflow.js";

export type OutboxTaskStatus = "pending" | "leased" | "published" | "dead_letter";

export interface ScheduledTaskOutboxRecord {
  id: string;
  idempotencyKey: string;
  orderId: string;
  taskType: ScheduledFulfillmentTaskEnvelope["taskType"];
  /** Persist the complete, non-sensitive task envelope so workers can resume after restarts. */
  payload: ScheduledFulfillmentTaskEnvelope;
  executeAtUtc: string;
  status: OutboxTaskStatus;
  attemptCount: number;
  createdAtUtc: string;
  updatedAtUtc: string;
  availableAtUtc: string;
  leaseToken?: string;
  leaseExpiresAtUtc?: string;
  publishedAtUtc?: string;
  lastErrorCode?: string;
}

export interface ScheduledTaskOutboxStore {
  /** Must atomically insert or return the existing row for a unique idempotencyKey. */
  enqueue(record: ScheduledTaskOutboxRecord): Promise<"inserted" | "already_exists">;
  /** Must atomically lease due rows so concurrent workers cannot claim the same row. */
  claimDue(input: {
    nowUtc: string;
    leaseToken: string;
    leaseDurationSeconds: number;
    limit: number;
  }): Promise<readonly ScheduledTaskOutboxRecord[]>;
  /** Must update only when the current leaseToken matches. */
  markPublished(input: {
    id: string;
    leaseToken: string;
    publishedAtUtc: string;
  }): Promise<boolean>;
  /** Must update only when the current leaseToken matches. */
  retry(input: {
    id: string;
    leaseToken: string;
    availableAtUtc: string;
    nowUtc: string;
    errorCode: string;
  }): Promise<boolean>;
  /** Must update only when the current leaseToken matches. */
  deadLetter(input: {
    id: string;
    leaseToken: string;
    nowUtc: string;
    errorCode: string;
  }): Promise<boolean>;
}

export interface ScheduledTaskOutboxInput {
  id: string;
  task: ScheduledFulfillmentTaskEnvelope;
  nowUtc: string;
}

/** Creates a pending outbox row; persistence and unique constraints belong to the adapter. */
export function createScheduledTaskOutboxRecord(
  input: ScheduledTaskOutboxInput
): ScheduledTaskOutboxRecord | null {
  const now = Date.parse(input.nowUtc);
  const executeAt = Date.parse(input.task.executeAtUtc);
  if (!input.id.trim() || !input.task.orderId.trim() || !input.task.idempotencyKey.trim()) return null;
  if (!Number.isFinite(now) || !Number.isFinite(executeAt)) return null;
  if (input.task.orderId !== input.task.plan.orderId) return null;

  const timestamp = new Date(now).toISOString();
  return {
    id: input.id,
    idempotencyKey: input.task.idempotencyKey,
    orderId: input.task.orderId,
    taskType: input.task.taskType,
    payload: { ...input.task, executeAtUtc: new Date(executeAt).toISOString() },
    executeAtUtc: new Date(executeAt).toISOString(),
    status: "pending",
    attemptCount: 0,
    createdAtUtc: timestamp,
    updatedAtUtc: timestamp,
    availableAtUtc: new Date(Math.max(now, executeAt)).toISOString()
  };
}

/** Bounded exponential retry delay. Attempt 1 receives baseDelaySeconds. */
export function scheduledTaskRetryAtUtc(input: {
  nowUtc: string;
  attemptCount: number;
  baseDelaySeconds?: number;
  maxDelaySeconds?: number;
}): string | null {
  const now = Date.parse(input.nowUtc);
  const base = input.baseDelaySeconds ?? 15;
  const maximum = input.maxDelaySeconds ?? 900;
  if (!Number.isFinite(now) || !Number.isSafeInteger(input.attemptCount) || input.attemptCount < 1) return null;
  if (!Number.isSafeInteger(base) || base < 1 || !Number.isSafeInteger(maximum) || maximum < base) return null;
  const delay = Math.min(maximum, base * (2 ** Math.min(input.attemptCount - 1, 30)));
  return new Date(now + delay * 1_000).toISOString();
}

/** Validates a claimed row before a worker attempts publication. */
export function isScheduledTaskLeaseValid(input: {
  record: ScheduledTaskOutboxRecord;
  leaseToken: string;
  nowUtc: string;
}): boolean {
  const now = Date.parse(input.nowUtc);
  const expires = input.record.leaseExpiresAtUtc ? Date.parse(input.record.leaseExpiresAtUtc) : Number.NaN;
  return input.record.status === "leased" &&
    Boolean(input.leaseToken) &&
    input.record.leaseToken === input.leaseToken &&
    Number.isFinite(now) &&
    Number.isFinite(expires) &&
    expires > now;
}
