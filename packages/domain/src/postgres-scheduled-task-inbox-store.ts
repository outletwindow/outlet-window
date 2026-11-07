import type { ScheduledTaskInboxRecord, ScheduledTaskInboxStore } from "./scheduled-task-inbox.js";
import type { PostgresPool } from "./postgres-iam-store.js";

type InboxRow = {
  id: string; tenant_id: string; order_id: string; idempotency_key: string;
  task_type: ScheduledTaskInboxRecord["taskType"];
  payload: ScheduledTaskInboxRecord["payload"];
  status: ScheduledTaskInboxRecord["status"];
  attempt_count: number;
  created_at: Date | string; updated_at: Date | string; available_at: Date | string;
  lease_token: string | null; lease_expires_at: Date | string | null;
  processed_at: Date | string | null; last_error_code: string | null;
};
const iso = (value: Date | string) => new Date(value).toISOString();

function fromRow(row: InboxRow): ScheduledTaskInboxRecord {
  return {
    id: row.id, tenantId: row.tenant_id, orderId: row.order_id,
    idempotencyKey: row.idempotency_key, taskType: row.task_type,
    payload: row.payload, status: row.status, attemptCount: row.attempt_count,
    createdAtUtc: iso(row.created_at), updatedAtUtc: iso(row.updated_at),
    availableAtUtc: iso(row.available_at),
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAtUtc: iso(row.lease_expires_at) }),
    ...(row.processed_at === null ? {} : { processedAtUtc: iso(row.processed_at) }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code })
  };
}

/** Durable inbox lease store; all acknowledgements use lease-token compare-and-swap. */
export class PostgresScheduledTaskInboxStore implements ScheduledTaskInboxStore {
  constructor(private readonly pool: PostgresPool) {}

  async claimDue(input: {
    nowUtc: string; leaseToken: string; leaseDurationSeconds: number; limit: number;
  }): Promise<readonly ScheduledTaskInboxRecord[]> {
    const now = Date.parse(input.nowUtc);
    if (!Number.isFinite(now) || !input.leaseToken.trim() ||
        !Number.isSafeInteger(input.leaseDurationSeconds) || input.leaseDurationSeconds < 5 ||
        input.leaseDurationSeconds > 3600 || !Number.isSafeInteger(input.limit) ||
        input.limit < 1 || input.limit > 100) throw new Error("invalid_scheduled_inbox_claim");
    const result = await this.pool.query<InboxRow>(
      `WITH due AS (
         SELECT id FROM scheduled_task_inbox
         WHERE (status = 'pending' AND available_at <= $1)
            OR (status = 'processing' AND lease_expires_at <= $1)
         ORDER BY COALESCE(lease_expires_at, available_at), created_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE scheduled_task_inbox task
       SET status = 'processing', attempt_count = task.attempt_count + 1,
           lease_token = $3 || ':' || task.id,
           lease_expires_at = $1 + ($4::integer * interval '1 second'),
           updated_at = $1
       FROM due WHERE task.id = due.id
       RETURNING task.*`,
      [new Date(now).toISOString(), input.limit, input.leaseToken, input.leaseDurationSeconds]
    );
    return result.rows.map(fromRow);
  }

  async complete(input: { id: string; leaseToken: string; nowUtc: string }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE scheduled_task_inbox
       SET status = 'completed', processed_at = $3, updated_at = $3,
           lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL
       WHERE id = $1 AND status = 'processing' AND lease_token = $2 AND lease_expires_at > $3`,
      [input.id, input.leaseToken, input.nowUtc]
    );
    return result.rowCount === 1;
  }

  async retry(input: {
    id: string; leaseToken: string; nowUtc: string; availableAtUtc: string; errorCode: string;
  }): Promise<boolean> {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(input.errorCode)) {
      throw new Error("invalid_scheduled_inbox_error_code");
    }
    const result = await this.pool.query(
      `UPDATE scheduled_task_inbox
       SET status = 'pending', available_at = $4, updated_at = $3,
           lease_token = NULL, lease_expires_at = NULL, last_error_code = $5
       WHERE id = $1 AND status = 'processing' AND lease_token = $2 AND lease_expires_at > $3`,
      [input.id, input.leaseToken, input.nowUtc, input.availableAtUtc, input.errorCode]
    );
    return result.rowCount === 1;
  }

  async deadLetter(input: {
    id: string; leaseToken: string; nowUtc: string; errorCode: string;
  }): Promise<boolean> {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(input.errorCode)) {
      throw new Error("invalid_scheduled_inbox_error_code");
    }
    const result = await this.pool.query(
      `UPDATE scheduled_task_inbox
       SET status = 'dead_letter', updated_at = $3,
           lease_token = NULL, lease_expires_at = NULL, last_error_code = $4
       WHERE id = $1 AND status = 'processing' AND lease_token = $2 AND lease_expires_at > $3`,
      [input.id, input.leaseToken, input.nowUtc, input.errorCode]
    );
    return result.rowCount === 1;
  }
}
