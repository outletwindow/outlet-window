import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresFulfillmentReceiptReader } from "../../../packages/domain/src/postgres-fulfillment-receipt-reader.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgreSQL fulfillment provider receipt reader", () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 3 }) : null;
  if (!pool) throw new Error("Pool must exist when DATABASE_URL is configured");
  const reader = new PostgresFulfillmentReceiptReader(pool);
  const suffix = randomUUID();
  const tenantId = "platform";
  const orderId = "receipt-order-" + suffix;
  const inboxId = "receipt-inbox-" + suffix;
  const suborderId = "receipt-suborder-" + suffix;

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO customer_orders
       (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
       VALUES ($1,$2,$3,$4,'awaiting_payment','SAR',10000)`,
      [orderId, tenantId, "receipt-customer-" + suffix, "receipt-order-idem-" + suffix]
    );
    await pool.query(
      `INSERT INTO scheduled_task_inbox
       (id,tenant_id,order_id,idempotency_key,task_type,payload,status,attempt_count,
        available_at,processed_at,provider_reference)
       VALUES ($1,$2,$3,$4,'merchant_preparation',$5::jsonb,'completed',1,
        '2026-11-08T10:00:00Z','2026-11-08T10:02:00Z','provider-ref-' || $1)`,
      [inboxId, tenantId, orderId, "receipt-task-idem-" + suffix, JSON.stringify({
        orderId, idempotencyKey: "receipt-task-idem-" + suffix,
        taskType: "merchant_preparation", executeAtUtc: "2026-11-08T10:00:00.000Z",
        plan: { orderId },
        target: {
          merchantTenantId: "merchant-tenant-" + suffix,
          suborderId, merchantId: "merchant-" + suffix, branchId: "branch-" + suffix
        }
      })]
    );
  });

  afterEach(async () => {
    await pool.query("DELETE FROM scheduled_task_inbox WHERE id = $1", [inboxId]);
    await pool.query("DELETE FROM customer_orders WHERE id = $1", [orderId]);
  });
  afterAll(async () => { await pool.end(); });

  it("reads completed provider receipts for the authorized tenant and order scope", async () => {
    const result = await reader.listForOrder({ tenantId, orderId });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      inboxId, tenantId, orderId, suborderId,
      merchantTenantId: "merchant-tenant-" + suffix,
      merchantId: "merchant-" + suffix, branchId: "branch-" + suffix,
      taskType: "merchant_preparation",
      providerReference: "provider-ref-" + inboxId,
      acceptedAtUtc: "2026-11-08T10:02:00.000Z"
    });
  });

  it("does not return receipts across tenant, order, or suborder boundaries", async () => {
    await expect(reader.listForOrder({ tenantId: "another-platform", orderId })).resolves.toEqual([]);
    await expect(reader.listForOrder({ tenantId, orderId: "another-order" })).resolves.toEqual([]);
    await expect(reader.listForOrder({ tenantId, orderId, suborderId: "another-suborder" })).resolves.toEqual([]);
    await expect(reader.listForOrder({ tenantId, orderId, suborderId })).resolves.toHaveLength(1);
  });
});
