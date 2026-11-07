import type { ScheduledTaskOutboxRecord, ScheduledTaskOutboxStore } from "./scheduled-task-outbox.js";
import type { ScheduledOrderCommitTransaction, ScheduledOrderConfirmation, ScheduledOrderTransactionRunner } from "./scheduled-order-commit.js";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";

type OutboxRow = {
  id: string; idempotency_key: string; order_id: string;
  task_type: ScheduledTaskOutboxRecord["taskType"]; execute_at: Date | string;
  status: ScheduledTaskOutboxRecord["status"]; attempt_count: number;
  created_at: Date | string; updated_at: Date | string; available_at: Date | string;
  lease_token: string | null; lease_expires_at: Date | string | null;
  published_at: Date | string | null; last_error_code: string | null;
  payload: ScheduledTaskOutboxRecord["payload"];
};
const iso = (value: Date | string) => new Date(value).toISOString();
const optionalIso = (value: Date | string | null) => value === null ? undefined : iso(value);

function fromRow(row: OutboxRow): ScheduledTaskOutboxRecord {
  return {
    id: row.id, idempotencyKey: row.idempotency_key, orderId: row.order_id,
    taskType: row.task_type, executeAtUtc: iso(row.execute_at), status: row.status,
    attemptCount: row.attempt_count, createdAtUtc: iso(row.created_at),
    updatedAtUtc: iso(row.updated_at), availableAtUtc: iso(row.available_at),
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAtUtc: iso(row.lease_expires_at) }),
    ...(row.published_at === null ? {} : { publishedAtUtc: iso(row.published_at) }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    payload: row.payload
  };
}

async function insertOutboxRecord(client: PostgresClient, record: ScheduledTaskOutboxRecord): Promise<"inserted" | "already_exists"> {
  const tenant = await client.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM customer_orders WHERE id = $1",
    [record.orderId]
  );
  const tenantId = tenant.rows[0]?.tenant_id;
  if (!tenantId) throw new Error("scheduled_outbox_order_not_found");

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO scheduled_task_outbox
      (id, tenant_id, order_id, idempotency_key, task_type, execute_at, status,
       attempt_count, created_at, updated_at, available_at, payload)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [record.id, tenantId, record.orderId, record.idempotencyKey, record.taskType,
      record.executeAtUtc, record.attemptCount, record.createdAtUtc,
      record.updatedAtUtc, record.availableAtUtc, JSON.stringify(record.payload)]
  );
  if (inserted.rowCount === 1) return "inserted";

  const existing = await client.query<{ order_id: string; task_type: string; same_payload: boolean }>(
    "SELECT order_id, task_type, payload = $2::jsonb AS same_payload FROM scheduled_task_outbox WHERE idempotency_key = $1",
    [record.idempotencyKey, JSON.stringify(record.payload)]
  );
  const row = existing.rows[0];
  if (row && row.order_id === record.orderId && row.task_type === record.taskType && row.same_payload) return "already_exists";
  throw new Error("scheduled_outbox_idempotency_conflict");
}

/** PostgreSQL implementation with atomic SKIP LOCKED claims and lease-token compare-and-swap updates. */
export class PostgresScheduledTaskOutboxStore implements ScheduledTaskOutboxStore {
  constructor(private readonly pool: PostgresPool) {}

  async enqueue(record: ScheduledTaskOutboxRecord): Promise<"inserted" | "already_exists"> {
    const client = await this.pool.connect();
    try { return await insertOutboxRecord(client, record); }
    finally { client.release(); }
  }

  async claimDue(input: {
    nowUtc: string; leaseToken: string; leaseDurationSeconds: number; limit: number;
  }): Promise<readonly ScheduledTaskOutboxRecord[]> {
    const now = Date.parse(input.nowUtc);
    if (!Number.isFinite(now) || !input.leaseToken.trim() ||
        !Number.isSafeInteger(input.leaseDurationSeconds) || input.leaseDurationSeconds < 5 ||
        input.leaseDurationSeconds > 3600 || !Number.isSafeInteger(input.limit) ||
        input.limit < 1 || input.limit > 100) throw new Error("invalid_scheduled_task_claim");
    const result = await this.pool.query<OutboxRow>(
      `WITH due AS (
         SELECT id FROM scheduled_task_outbox
         WHERE (status = 'pending' AND available_at <= $1)
            OR (status = 'leased' AND lease_expires_at <= $1)
         ORDER BY COALESCE(lease_expires_at, available_at), created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE scheduled_task_outbox task
       SET status = 'leased', attempt_count = task.attempt_count + 1,
           lease_token = $3 || ':' || task.id,
           lease_expires_at = $1 + ($4::integer * interval '1 second'),
           updated_at = $1
       FROM due WHERE task.id = due.id
       RETURNING task.*`,
      [new Date(now).toISOString(), input.limit, input.leaseToken, input.leaseDurationSeconds]
    );
    return result.rows.map(fromRow);
  }

  async markPublished(input: { id: string; leaseToken: string; publishedAtUtc: string }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE scheduled_task_outbox
       SET status = 'published', published_at = $3, updated_at = $3,
           lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL
       WHERE id = $1 AND status = 'leased' AND lease_token = $2 AND lease_expires_at > $3`,
      [input.id, input.leaseToken, input.publishedAtUtc]
    );
    return result.rowCount === 1;
  }

  async retry(input: { id: string; leaseToken: string; availableAtUtc: string; nowUtc: string; errorCode: string }): Promise<boolean> {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(input.errorCode)) throw new Error("invalid_scheduled_task_error_code");
    const result = await this.pool.query(
      `UPDATE scheduled_task_outbox
       SET status = 'pending', available_at = $4, updated_at = $3,
           lease_token = NULL, lease_expires_at = NULL, last_error_code = $5
       WHERE id = $1 AND status = 'leased' AND lease_token = $2 AND lease_expires_at > $3`,
      [input.id, input.leaseToken, input.nowUtc, input.availableAtUtc, input.errorCode]
    );
    return result.rowCount === 1;
  }

  async deadLetter(input: { id: string; leaseToken: string; nowUtc: string; errorCode: string }): Promise<boolean> {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(input.errorCode)) throw new Error("invalid_scheduled_task_error_code");
    const result = await this.pool.query(
      `UPDATE scheduled_task_outbox
       SET status = 'dead_letter', updated_at = $3,
           lease_token = NULL, lease_expires_at = NULL, last_error_code = $4
       WHERE id = $1 AND status = 'leased' AND lease_token = $2 AND lease_expires_at > $3`,
      [input.id, input.leaseToken, input.nowUtc, input.errorCode]
    );
    return result.rowCount === 1;
  }

  async listByOrder(input: { tenantId: string; orderId: string }): Promise<readonly ScheduledTaskOutboxRecord[]> {
    const result = await this.pool.query<OutboxRow>(
      "SELECT * FROM scheduled_task_outbox WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id",
      [input.tenantId, input.orderId]
    );
    return result.rows.map(fromRow);
  }
}

/** Persists the confirmed order and its outbox tasks on one PostgreSQL transaction/client. */
export class PostgresScheduledOrderTransactionRunner implements ScheduledOrderTransactionRunner {
  constructor(private readonly pool: PostgresPool) {}

  async run<T>(work: (transaction: ScheduledOrderCommitTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const transaction: ScheduledOrderCommitTransaction = {
        saveConfirmedOrder: async (order: ScheduledOrderConfirmation) => {
          const existing = await client.query<{
            payment_reference: string; payment_captured_at: Date | string;
            confirmed_at: Date | string; fulfillment_version: number;
          }>(
            "SELECT payment_reference, payment_captured_at, confirmed_at, fulfillment_version FROM scheduled_order_confirmations WHERE tenant_id = $1 AND order_id = $2 FOR UPDATE",
            [order.tenantId, order.orderId]
          );
          if (existing.rowCount) {
            const row = existing.rows[0]!;
            if (row.payment_reference !== order.paymentReference ||
                iso(row.payment_captured_at) !== iso(order.paymentCapturedAtUtc) ||
                iso(row.confirmed_at) !== iso(order.confirmedAtUtc) ||
                row.fulfillment_version !== order.fulfillmentVersion) {
              throw new Error("scheduled_order_confirmation_conflict");
            }
            return;
          }
          const updated = await client.query(
            `UPDATE customer_orders SET status = 'confirmed', version = version + 1, updated_at = $3
             WHERE tenant_id = $1 AND id = $2 AND status IN ('pending_validation','awaiting_payment')`,
            [order.tenantId, order.orderId, order.confirmedAtUtc]
          );
          if (updated.rowCount !== 1) throw new Error("scheduled_order_not_awaiting_payment");
          await client.query(
            `INSERT INTO scheduled_order_confirmations
              (order_id, tenant_id, payment_reference, payment_captured_at, confirmed_at, fulfillment_version)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [order.orderId, order.tenantId, order.paymentReference, order.paymentCapturedAtUtc,
              order.confirmedAtUtc, order.fulfillmentVersion]
          );
        },
        enqueueOutbox: record => insertOutboxRecord(client, record)
      };
      const result = await work(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
