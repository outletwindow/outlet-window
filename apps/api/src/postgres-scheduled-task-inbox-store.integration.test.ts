import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresScheduledTaskInboxStore } from "../../../packages/domain/src/postgres-scheduled-task-inbox-store.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgreSQL scheduled task inbox leases", () => {
  const configuredPool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 8 }) : null;
  if (!configuredPool) throw new Error("Pool must exist when DATABASE_URL is configured");
  const pool: Pool = configuredPool;
  const store = new PostgresScheduledTaskInboxStore(pool);
  let orderId = "";
  let inboxId = "";
  let idempotencyKey = "";

  beforeEach(async () => {
    const suffix = randomUUID();
    orderId = "inbox-order-" + suffix;
    inboxId = "inbox-row-" + suffix;
    idempotencyKey = "inbox-task-idem-" + suffix;
    await pool.query(
      `INSERT INTO customer_orders
       (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
       VALUES ($1,'platform',$2,$3,'awaiting_payment','SAR',10000)`,
      [orderId, "inbox-customer-" + suffix, "inbox-order-idem-" + suffix]
    );
    await pool.query(
      `INSERT INTO scheduled_task_inbox
       (id,tenant_id,order_id,idempotency_key,task_type,payload,status,attempt_count,available_at)
       VALUES ($1,'platform',$2,$3,'merchant_preparation',$4::jsonb,'pending',0,'2026-11-08T10:00:00Z')`,
      [inboxId, orderId, idempotencyKey, JSON.stringify({
        orderId, idempotencyKey, taskType: "merchant_preparation",
        executeAtUtc: "2026-11-08T10:00:00.000Z",
        plan: { orderId }
      })]
    );
  });

  async function cleanup() {
    await pool.query("DELETE FROM scheduled_task_inbox WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM customer_orders WHERE id = $1", [orderId]);
  }
  afterEach(cleanup);
  afterAll(async () => { await pool.end(); });

  it("claims due inbox rows once across concurrent workers", async () => {
    const [a, b] = await Promise.all([
      store.claimDue({ nowUtc: "2026-11-08T10:00:00.000Z", leaseToken: "worker-a", leaseDurationSeconds: 30, limit: 1 }),
      store.claimDue({ nowUtc: "2026-11-08T10:00:00.000Z", leaseToken: "worker-b", leaseDurationSeconds: 30, limit: 1 })
    ]);
    expect(a.length + b.length).toBe(1);
    const claimed = [...a, ...b][0]!;
    expect(claimed.status).toBe("processing");
    expect(claimed.attemptCount).toBe(1);
  });

  it("reclaims expired leases and rejects stale worker completion", async () => {
    const first = await store.claimDue({
      nowUtc: "2026-11-08T10:00:00.000Z", leaseToken: "worker-a", leaseDurationSeconds: 5, limit: 1
    });
    const second = await store.claimDue({
      nowUtc: "2026-11-08T10:00:06.000Z", leaseToken: "worker-b", leaseDurationSeconds: 30, limit: 1
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(await store.complete({
      id: inboxId, leaseToken: first[0]!.leaseToken!, nowUtc: "2026-11-08T10:00:06.000Z"
    })).toBe(false);
    expect(await store.complete({
      id: inboxId, leaseToken: second[0]!.leaseToken!, nowUtc: "2026-11-08T10:00:07.000Z"
    })).toBe(true);
  });

  it("retries and dead-letters only under the active lease", async () => {
    const claimed = await store.claimDue({
      nowUtc: "2026-11-08T10:00:00.000Z", leaseToken: "worker-a", leaseDurationSeconds: 30, limit: 1
    });
    const leaseToken = claimed[0]!.leaseToken!;
    expect(await store.retry({
      id: inboxId, leaseToken, nowUtc: "2026-11-08T10:00:01.000Z",
      availableAtUtc: "2026-11-08T10:00:16.000Z", errorCode: "TEMPORARY_FAILURE"
    })).toBe(true);
    const retryClaim = await store.claimDue({
      nowUtc: "2026-11-08T10:00:16.000Z", leaseToken: "worker-b", leaseDurationSeconds: 30, limit: 1
    });
    expect(retryClaim).toHaveLength(1);
    expect(await store.deadLetter({
      id: inboxId, leaseToken: retryClaim[0]!.leaseToken!,
      nowUtc: "2026-11-08T10:00:17.000Z", errorCode: "PERMANENT_FAILURE"
    })).toBe(true);
  });
});
