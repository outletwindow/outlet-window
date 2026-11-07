import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createScheduledTaskOutboxRecord,
  PostgresScheduledOrderTransactionRunner,
  PostgresScheduledTaskOutboxStore,
  PostgresScheduledTaskInboxPublisher,
  commitScheduledOrderAndTasks,
  type ScheduledFulfillmentTaskEnvelope
} from "../../../packages/domain/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgreSQL scheduled task outbox", () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 6 }) : null;
  if (!pool) throw new Error("Pool must exist when DATABASE_URL is configured");
  const store = new PostgresScheduledTaskOutboxStore(pool);
  const transactionRunner = new PostgresScheduledOrderTransactionRunner(pool);
  const inboxPublisher = new PostgresScheduledTaskInboxPublisher(pool);
  let orderId = "";
  let customerId = "";

  beforeEach(async () => {
    const suffix = randomUUID();
    orderId = "scheduled-order-" + suffix;
    customerId = "scheduled-customer-" + suffix;
    await pool.query(
      `INSERT INTO customer_orders
        (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
       VALUES ($1,'platform',$2,$3,'awaiting_payment','SAR',10000)`,
      [orderId, customerId, "scheduled-idem-" + suffix]
    );
  });

  afterAll(async () => { await pool.end(); });

  function task(overrides: Partial<ScheduledFulfillmentTaskEnvelope> = {}): ScheduledFulfillmentTaskEnvelope {
    const plan = {
      orderId, fulfillmentType: "store_pickup" as const,
      scheduledFor: "2026-11-08T13:00:00+03:00",
      scheduledForUtc: "2026-11-08T10:00:00.000Z",
      paymentDueAt: "2026-11-08T09:00:00.000Z",
      inventoryReservationDueAt: "2026-11-08T10:00:00.000Z",
      preparationReleaseAtUtc: "2026-11-08T11:00:00.000Z",
      estimate: { preparationMinutes: 60, bufferMinutes: 0, travelMinutes: 0 },
      createdAt: "2026-11-08T09:00:00.000Z"
    };
    return {
      idempotencyKey: "scheduled-fulfillment:" + orderId + ":merchant_reservation:v1",
      orderId, taskType: "merchant_reservation", executeAtUtc: "2026-11-08T10:00:00.000Z",
      plan, ...overrides
    };
  }

  async function cleanup() {
    await pool.query("DELETE FROM scheduled_task_inbox WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM scheduled_task_outbox WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM scheduled_order_confirmations WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM customer_orders WHERE id = $1", [orderId]);
  }

  afterEach(async () => { await cleanup(); });

  it("deduplicates identical enqueue requests and rejects conflicting payload reuse", async () => {
    const record = createScheduledTaskOutboxRecord({
      id: "outbox-" + randomUUID(), task: task(), nowUtc: "2026-11-08T09:00:00.000Z"
    })!;
    await expect(store.enqueue(record)).resolves.toBe("inserted");
    await expect(store.enqueue({ ...record, id: "different-row-id" })).resolves.toBe("already_exists");
    const conflicting = createScheduledTaskOutboxRecord({
      id: "conflict-" + randomUUID(),
      task: task({ executeAtUtc: "2026-11-08T10:30:00.000Z" }),
      nowUtc: "2026-11-08T09:00:00.000Z"
    })!;
    await expect(store.enqueue(conflicting)).rejects.toThrow("scheduled_outbox_idempotency_conflict");
  });

  it("allows only one concurrent worker to claim a due task", async () => {
    const record = createScheduledTaskOutboxRecord({
      id: "outbox-" + randomUUID(), task: task(), nowUtc: "2026-11-08T09:00:00.000Z"
    })!;
    await store.enqueue(record);
    const [a, b] = await Promise.all([
      store.claimDue({ nowUtc: "2026-11-08T10:00:00.000Z", leaseToken: "worker-a", leaseDurationSeconds: 30, limit: 1 }),
      store.claimDue({ nowUtc: "2026-11-08T10:00:00.000Z", leaseToken: "worker-b", leaseDurationSeconds: 30, limit: 1 })
    ]);
    expect(a.length + b.length).toBe(1);
    await cleanup();
  });

  it("reclaims expired leases and rejects stale worker acknowledgements", async () => {
    const record = createScheduledTaskOutboxRecord({
      id: "outbox-" + randomUUID(), task: task(), nowUtc: "2026-11-08T09:00:00.000Z"
    })!;
    await store.enqueue(record);
    const first = await store.claimDue({
      nowUtc: "2026-11-08T10:00:00.000Z", leaseToken: "first-worker", leaseDurationSeconds: 5, limit: 1
    });
    const second = await store.claimDue({
      nowUtc: "2026-11-08T10:00:06.000Z", leaseToken: "second-worker", leaseDurationSeconds: 30, limit: 1
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(await store.markPublished({
      id: record.id, leaseToken: first[0]!.leaseToken!, publishedAtUtc: "2026-11-08T10:00:06.000Z"
    })).toBe(false);
    expect(await store.markPublished({
      id: record.id, leaseToken: second[0]!.leaseToken!, publishedAtUtc: "2026-11-08T10:00:07.000Z"
    })).toBe(true);
    await cleanup();
  });

  it("commits payment-confirmed order state and outbox tasks atomically", async () => {
    const scheduledTask = task();
    const result = await commitScheduledOrderAndTasks({
      order: {
        orderId, tenantId: "platform", paymentReference: "provider-" + randomUUID(),
        paymentCapturedAtUtc: "2026-11-08T09:59:00.000Z",
        confirmedAtUtc: "2026-11-08T10:00:00.000Z", fulfillmentVersion: 1
      },
      tasks: [scheduledTask],
      outboxIdForTask: () => "outbox-" + randomUUID(),
      transactionRunner
    });
    expect(result).toMatchObject({ status: "committed", taskCount: 1 });
    const order = await pool.query<{ status: string }>(
      "SELECT status FROM customer_orders WHERE id = $1", [orderId]
    );
    expect(order.rows[0]?.status).toBe("awaiting_payment");
    const records = await store.listByOrder({ tenantId: "platform", orderId });
    expect(records).toHaveLength(1);
    expect(records[0]?.payload.idempotencyKey).toBe(scheduledTask.idempotencyKey);
    await cleanup();
  });

  it("serializes concurrent confirmation retries without duplicating outbox work", async () => {
    const scheduledTask = task();
    const confirmation = {
      orderId, tenantId: "platform", paymentReference: "provider-" + randomUUID(),
      paymentCapturedAtUtc: "2026-11-08T09:59:00.000Z",
      confirmedAtUtc: "2026-11-08T10:00:00.000Z", fulfillmentVersion: 1
    };
    const commit = () => commitScheduledOrderAndTasks({
      order: confirmation,
      tasks: [scheduledTask],
      outboxIdForTask: () => "outbox-" + randomUUID(),
      transactionRunner
    });
    const results = await Promise.all([commit(), commit()]);
    expect(results.every(result => result.status === "committed")).toBe(true);
    expect(await store.listByOrder({ tenantId: "platform", orderId })).toHaveLength(1);
    const confirmations = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM scheduled_order_confirmations WHERE order_id = $1",
      [orderId]
    );
    expect(confirmations.rows[0]?.count).toBe("1");
  });

  it("publishes to the durable inbox idempotently", async () => {
    const scheduledTask = task();
    await inboxPublisher.publish(scheduledTask, scheduledTask.idempotencyKey);
    await inboxPublisher.publish(scheduledTask, scheduledTask.idempotencyKey);
    const inbox = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM scheduled_task_inbox WHERE order_id = $1",
      [orderId]
    );
    expect(inbox.rows[0]?.count).toBe("1");
    await expect(inboxPublisher.publish(
      { ...scheduledTask, executeAtUtc: "2026-11-08T10:30:00.000Z" },
      scheduledTask.idempotencyKey
    )).rejects.toThrow("scheduled_inbox_idempotency_conflict");
  });

  it("enforces tenant scope when reading order tasks", async () => {
    const record = createScheduledTaskOutboxRecord({
      id: "outbox-" + randomUUID(), task: task(), nowUtc: "2026-11-08T09:00:00.000Z"
    })!;
    await store.enqueue(record);
    expect(await store.listByOrder({ tenantId: "wrong-tenant", orderId })).toEqual([]);
    expect(await store.listByOrder({ tenantId: "platform", orderId })).toHaveLength(1);
    await cleanup();
  });
});
