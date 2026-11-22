import type { ScheduledFulfillmentTaskEnvelope } from "./scheduled-fulfillment-workflow.js";
import type { ScheduledTaskOutboxRecord } from "./scheduled-task-outbox.js";

export type ScheduledTaskReconciliationIssue =
  | { type: "missing_task"; idempotencyKey: string; severity: "critical" }
  | { type: "duplicate_task"; idempotencyKey: string; recordIds: readonly string[]; severity: "high" }
  | { type: "unexpected_task"; recordId: string; idempotencyKey: string; severity: "high" }
  | { type: "dead_letter"; recordId: string; idempotencyKey: string; severity: "critical" }
  | { type: "expired_lease"; recordId: string; idempotencyKey: string; severity: "high" }
  | { type: "stale_pending"; recordId: string; idempotencyKey: string; severity: "warning" }
  | { type: "invalid_record"; recordId: string; severity: "high" };

export interface ScheduledTaskReconciliationResult {
  orderId: string;
  checkedAtUtc: string;
  expectedTaskCount: number;
  persistedTaskCount: number;
  healthy: boolean;
  issues: readonly ScheduledTaskReconciliationIssue[];
}

/** Read-only port. Implementations must scope all reads to the authorized tenant/order. */
export interface ScheduledTaskReconciliationReader {
  listByOrder(input: {
    tenantId: string;
    orderId: string;
  }): Promise<readonly ScheduledTaskOutboxRecord[]>;
}

export function reconcileScheduledOrderTasks(input: {
  orderId: string;
  expectedTasks: readonly ScheduledFulfillmentTaskEnvelope[];
  persistedRecords: readonly ScheduledTaskOutboxRecord[];
  nowUtc: string;
  pendingStaleAfterSeconds?: number;
}): ScheduledTaskReconciliationResult | null {
  const now = Date.parse(input.nowUtc);
  const staleAfter = input.pendingStaleAfterSeconds ?? 300;
  if (!input.orderId.trim() || !Number.isFinite(now) ||
      !Number.isSafeInteger(staleAfter) || staleAfter < 1) return null;
  if (input.expectedTasks.some(task => task.orderId !== input.orderId ||
      task.plan.orderId !== input.orderId || !task.idempotencyKey.trim())) return null;
  if (input.persistedRecords.some(record => record.orderId !== input.orderId)) return null;

  const issues: ScheduledTaskReconciliationIssue[] = [];
  const expectedKeys = new Set(input.expectedTasks.map(task => task.idempotencyKey));
  const recordsByKey = new Map<string, ScheduledTaskOutboxRecord[]>();
  for (const record of input.persistedRecords) {
    const group = recordsByKey.get(record.idempotencyKey) ?? [];
    group.push(record);
    recordsByKey.set(record.idempotencyKey, group);
  }

  for (const task of input.expectedTasks) {
    const matches = recordsByKey.get(task.idempotencyKey) ?? [];
    if (matches.length === 0) {
      issues.push({ type: "missing_task", idempotencyKey: task.idempotencyKey, severity: "critical" });
      continue;
    }
    if (matches.length > 1) {
      issues.push({
        type: "duplicate_task",
        idempotencyKey: task.idempotencyKey,
        recordIds: matches.map(record => record.id),
        severity: "high"
      });
    }
  }

  for (const record of input.persistedRecords) {
    if (!record.id.trim() || !record.idempotencyKey.trim() ||
        !Number.isFinite(Date.parse(record.createdAtUtc)) ||
        !Number.isFinite(Date.parse(record.updatedAtUtc)) ||
        !Number.isFinite(Date.parse(record.availableAtUtc))) {
      issues.push({ type: "invalid_record", recordId: record.id, severity: "high" });
      continue;
    }
    if (!expectedKeys.has(record.idempotencyKey)) {
      issues.push({
        type: "unexpected_task",
        recordId: record.id,
        idempotencyKey: record.idempotencyKey,
        severity: "high"
      });
      continue;
    }
    if (record.status === "dead_letter") {
      issues.push({ type: "dead_letter", recordId: record.id, idempotencyKey: record.idempotencyKey, severity: "critical" });
    } else if (record.status === "leased") {
      const leaseExpiry = record.leaseExpiresAtUtc ? Date.parse(record.leaseExpiresAtUtc) : Number.NaN;
      if (!Number.isFinite(leaseExpiry) || leaseExpiry <= now) {
        issues.push({ type: "expired_lease", recordId: record.id, idempotencyKey: record.idempotencyKey, severity: "high" });
      }
    } else if (record.status === "pending") {
      const updatedAt = Date.parse(record.updatedAtUtc);
      if (now - updatedAt >= staleAfter * 1_000) {
        issues.push({ type: "stale_pending", recordId: record.id, idempotencyKey: record.idempotencyKey, severity: "warning" });
      }
    }
  }

  return {
    orderId: input.orderId,
    checkedAtUtc: new Date(now).toISOString(),
    expectedTaskCount: input.expectedTasks.length,
    persistedTaskCount: input.persistedRecords.length,
    healthy: issues.length === 0,
    issues
  };
}
