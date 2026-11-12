import type { ScheduledFulfillmentTaskEnvelope } from "./scheduled-fulfillment-workflow.js";

export type ScheduledTaskInboxStatus = "pending" | "processing" | "completed" | "dead_letter";

export interface ScheduledTaskInboxRecord {
  id: string;
  tenantId: string;
  orderId: string;
  idempotencyKey: string;
  taskType: ScheduledFulfillmentTaskEnvelope["taskType"];
  payload: ScheduledFulfillmentTaskEnvelope;
  status: ScheduledTaskInboxStatus;
  attemptCount: number;
  createdAtUtc: string;
  updatedAtUtc: string;
  availableAtUtc: string;
  leaseToken?: string;
  leaseExpiresAtUtc?: string;
  processedAtUtc?: string;
  lastErrorCode?: string;
  providerReference?: string;
}

export interface ScheduledTaskInboxStore {
  claimDue(input: {
    nowUtc: string;
    leaseToken: string;
    leaseDurationSeconds: number;
    limit: number;
  }): Promise<readonly ScheduledTaskInboxRecord[]>;
  complete(input: { id: string; leaseToken: string; nowUtc: string; providerReference?: string }): Promise<boolean>;
  retry(input: {
    id: string; leaseToken: string; nowUtc: string; availableAtUtc: string; errorCode: string;
  }): Promise<boolean>;
  deadLetter(input: {
    id: string; leaseToken: string; nowUtc: string; errorCode: string;
  }): Promise<boolean>;
}

export interface ScheduledTaskConsumer {
  /** Must be idempotent by idempotencyKey; delivery is at-least-once. */
  handle(task: ScheduledFulfillmentTaskEnvelope, idempotencyKey: string): Promise<void | { providerReference: string }>;
}

export type ScheduledTaskConsumerHandlers =
  Partial<Record<ScheduledFulfillmentTaskEnvelope["taskType"], ScheduledTaskConsumer>>;

export class ScheduledTaskConsumeError extends Error {
  constructor(readonly code: string, readonly retryable = true) {
    super(code);
    this.name = "ScheduledTaskConsumeError";
  }
}

export interface ScheduledTaskInboxWorkerResult {
  claimed: number;
  completed: number;
  retried: number;
  deadLettered: number;
  leaseLost: number;
}

function safeErrorCode(error: unknown): string {
  const code = error instanceof ScheduledTaskConsumeError ? error.code : "CONSUMER_FAILED";
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : "CONSUMER_FAILED";
}

function validPayload(record: ScheduledTaskInboxRecord): boolean {
  const task = record.payload;
  const target = task.target;
  const targetValid = target === undefined || Boolean(
    target.merchantTenantId.trim() && target.suborderId.trim() &&
    target.merchantId.trim() && target.branchId.trim()
  );
  const targetRequired = task.taskType !== "merchant_reservation";
  return targetValid && (!targetRequired || target !== undefined) &&
    task.orderId === record.orderId && task.plan.orderId === record.orderId &&
    task.idempotencyKey === record.idempotencyKey &&
    task.taskType === record.taskType &&
    Number.isFinite(Date.parse(task.executeAtUtc));
}

function leaseValid(record: ScheduledTaskInboxRecord, token: string, nowUtc: string): boolean {
  const now = Date.parse(nowUtc);
  const expires = record.leaseExpiresAtUtc ? Date.parse(record.leaseExpiresAtUtc) : Number.NaN;
  return record.status === "processing" && Boolean(token) && record.leaseToken === token &&
    Number.isFinite(now) && Number.isFinite(expires) && expires > now;
}

function retryAt(nowUtc: string, attemptCount: number, baseSeconds: number, maxSeconds: number): string | null {
  const now = Date.parse(nowUtc);
  if (!Number.isFinite(now) || !Number.isSafeInteger(attemptCount) || attemptCount < 1 ||
      !Number.isSafeInteger(baseSeconds) || baseSeconds < 1 ||
      !Number.isSafeInteger(maxSeconds) || maxSeconds < baseSeconds) return null;
  const delay = Math.min(maxSeconds, baseSeconds * (2 ** Math.min(attemptCount - 1, 30)));
  return new Date(now + delay * 1000).toISOString();
}

/** Processes a bounded batch from the durable inbox with lease-CAS acknowledgement and retries. */
export async function runScheduledTaskInboxBatch(input: {
  store: ScheduledTaskInboxStore;
  handlers: ScheduledTaskConsumerHandlers;
  nowUtc: string;
  leaseToken: string;
  leaseDurationSeconds?: number;
  limit?: number;
  maxAttempts?: number;
  baseDelaySeconds?: number;
  maxDelaySeconds?: number;
  clock?: () => Date;
}): Promise<ScheduledTaskInboxWorkerResult> {
  const now = Date.parse(input.nowUtc);
  const maxAttempts = input.maxAttempts ?? 8;
  if (!Number.isFinite(now) || !input.leaseToken.trim() ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new Error("invalid_scheduled_inbox_worker_input");
  }
  const nowUtc = new Date(now).toISOString();
  const records = await input.store.claimDue({
    nowUtc, leaseToken: input.leaseToken,
    leaseDurationSeconds: input.leaseDurationSeconds ?? 60,
    limit: input.limit ?? 10
  });
  const clock = input.clock ?? (() => new Date(now));
  const result: ScheduledTaskInboxWorkerResult = {
    claimed: records.length, completed: 0, retried: 0, deadLettered: 0, leaseLost: 0
  };

  for (const record of records) {
    const leaseToken = record.leaseToken ?? "";
    if (!leaseValid(record, leaseToken, nowUtc)) {
      result.leaseLost += 1;
      continue;
    }
    if (!validPayload(record)) {
      const moved = await input.store.deadLetter({
        id: record.id, leaseToken, nowUtc, errorCode: "INVALID_TASK_PAYLOAD"
      });
      if (moved) result.deadLettered += 1;
      else result.leaseLost += 1;
      continue;
    }
    const handler = input.handlers[record.taskType];
    if (!handler) {
      const moved = await input.store.deadLetter({
        id: record.id, leaseToken, nowUtc, errorCode: "NO_CONSUMER_HANDLER"
      });
      if (moved) result.deadLettered += 1;
      else result.leaseLost += 1;
      continue;
    }
    try {
      const receipt = await handler.handle(record.payload, record.idempotencyKey);
      if (receipt !== undefined && (typeof receipt.providerReference !== "string" ||
          !receipt.providerReference.trim() || receipt.providerReference.length > 500)) {
        throw new ScheduledTaskConsumeError("INVALID_PROVIDER_REFERENCE", false);
      }
      const completed = await input.store.complete({
        id: record.id, leaseToken, nowUtc: clock().toISOString(),
        ...(receipt ? { providerReference: receipt.providerReference.trim() } : {})
      });
      if (completed) result.completed += 1;
      else result.leaseLost += 1;
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const failedAtUtc = clock().toISOString();
      const permanent = error instanceof ScheduledTaskConsumeError && !error.retryable;
      if (permanent || record.attemptCount >= maxAttempts) {
        const moved = await input.store.deadLetter({
          id: record.id, leaseToken, nowUtc: failedAtUtc, errorCode
        });
        if (moved) result.deadLettered += 1;
        else result.leaseLost += 1;
        continue;
      }
      const availableAtUtc = retryAt(
        failedAtUtc, record.attemptCount,
        input.baseDelaySeconds ?? 15, input.maxDelaySeconds ?? 900
      );
      if (!availableAtUtc) throw new Error("scheduled_inbox_retry_time_invalid");
      const retried = await input.store.retry({
        id: record.id, leaseToken, nowUtc: failedAtUtc, availableAtUtc, errorCode
      });
      if (retried) result.retried += 1;
      else result.leaseLost += 1;
    }
  }
  return result;
}
