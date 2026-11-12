import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresBranchInventoryReservationAdapter } from "../../../packages/domain/src/postgres-branch-inventory-reservation.js";
import { PostgresScheduledOrderTransactionRunner, PostgresScheduledTaskInboxPublisher } from "../../../packages/domain/src/postgres-scheduled-task-store.js";
import type { ScheduledFulfillmentTaskEnvelope } from "../../../packages/domain/src/scheduled-fulfillment-workflow.js";
import { PostgresBranchInventoryReservationLifecycle } from "../../../packages/domain/src/postgres-branch-inventory-reservation-lifecycle.js";
import { PostgresInventoryReservationExpiryWorker } from "../../../packages/domain/src/postgres-inventory-reservation-expiry-worker.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgreSQL branch inventory reservations", () => {
  const configuredPool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 8 }) : null;
  if (!configuredPool) throw new Error("Pool must exist when DATABASE_URL is configured");
  const pool: Pool = configuredPool;
  const adapter = new PostgresBranchInventoryReservationAdapter(pool);
  const paymentRecorder = new PostgresScheduledOrderTransactionRunner(pool);
  const inboxPublisher = new PostgresScheduledTaskInboxPublisher(pool);
  const lifecycle = new PostgresBranchInventoryReservationLifecycle(pool);
  const suffix = randomUUID();
  const merchantId = "inventory-merchant-" + suffix;
  const branchId = "inventory-branch-" + suffix;
  const variantId = "inventory-variant-" + suffix;
  const sku = "SKU-" + suffix;
  const tenantId = merchantId;
  const orderIds: string[] = [];

  async function createPaidOrder(quantity: number) {
    const id = "inventory-order-" + randomUUID();
    const suborderId = "inventory-suborder-" + randomUUID();
    orderIds.push(id);
    await pool.query(
      `INSERT INTO customer_orders
       (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
       VALUES ($1,'platform',$2,$3,'awaiting_payment','SAR',10000)`,
      [id, "inventory-customer-" + id, "inventory-idem-" + id]
    );
    await pool.query(
      `INSERT INTO merchant_suborders
       (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
       VALUES ($1,$2,$3,$2,$4,'awaiting_payment',10000)`,
      [suborderId, tenantId, id, branchId]
    );
    await pool.query(
      `INSERT INTO customer_order_items
       (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,product_variant_id,sku,quantity,unit_price_minor,currency)
       VALUES ($1,$2,$3,$4,$2,$5,$6,$7,$8,5000,'SAR')`,
      ["item-" + id, tenantId, id, suborderId, branchId, variantId, sku, quantity]
    );
    const capturedAtUtc = new Date().toISOString();
    const paymentReference = "payment-" + id;
    await pool.query(
      `INSERT INTO verified_order_payment_captures
       (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,
        amount_minor,currency,captured_at,idempotency_key)
       VALUES ($1,'platform',$2,'integration_test',$3,$4,10000,'SAR',$5,$6)`,
      ["capture-" + id, id, "event-" + id, paymentReference, capturedAtUtc, "capture-idem-" + id]
    );
    const paymentCapture = {
      orderId: id, tenantId: "platform", paymentReference,
      paymentCapturedAtUtc: capturedAtUtc, confirmedAtUtc: capturedAtUtc,
      fulfillmentVersion: 1
    };
    await expect(paymentRecorder.recordPaymentCapture(paymentCapture)).resolves.toBe("inserted");
    await expect(paymentRecorder.recordPaymentCapture(paymentCapture)).resolves.toBe("already_exists");
    const idempotencyKey = "inventory-reservation:" + id + ":v1";
    return {
      tenantId, orderId: id, suborderId, merchantId, branchId, idempotencyKey,
      requestedAtUtc: new Date().toISOString(),
      lines: [{ productVariantId: variantId, sku, quantity }]
    };
  }

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO merchants (id,legal_name,display_name,country_code,status)
       VALUES ($1,'Inventory Merchant LLC','Inventory Merchant','SA','active')`,
      [merchantId]
    );
    await pool.query(
      `INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
       VALUES ($1,$2,'Inventory Branch','JUB','active')`,
      [branchId, merchantId]
    );
    await pool.query(
      `INSERT INTO branch_inventory
       (merchant_id,branch_id,product_variant_id,sku,available_quantity,reserved_quantity,
        source,last_synced_at,availability_confidence)
       VALUES ($1,$2,$3,$4,1,0,'merchant_portal',now(),'high')`,
      [merchantId, branchId, variantId, sku]
    );
  });

  async function cleanup() {
    await pool.query("DELETE FROM scheduled_task_inbox WHERE order_id = ANY($1::text[])", [orderIds]);
    await pool.query("DELETE FROM inventory_reservation_lines WHERE reservation_id IN (SELECT id FROM inventory_reservations WHERE merchant_id = $1)", [merchantId]);
    await pool.query("DELETE FROM inventory_reservations WHERE merchant_id = $1", [merchantId]);
    await pool.query("DELETE FROM customer_order_items WHERE merchant_id = $1", [merchantId]);
    await pool.query("DELETE FROM scheduled_order_confirmations WHERE order_id = ANY($1::text[])", [orderIds]);
    // Verified provider captures are immutable audit evidence and intentionally outlive test cleanup.
    // Keep their parent customer_orders as well; each test uses fresh UUID-backed order IDs.
    await pool.query("DELETE FROM merchant_suborders WHERE merchant_id = $1", [merchantId]);
    await pool.query("DELETE FROM branch_inventory WHERE merchant_id = $1", [merchantId]);
    await pool.query("DELETE FROM merchant_branches WHERE merchant_id = $1", [merchantId]);
    await pool.query("DELETE FROM merchants WHERE id = $1", [merchantId]);
  }

  afterEach(cleanup);
  afterAll(async () => { await pool.end(); });

  it("atomically reserves exact order lines and is idempotent", async () => {
    const request = await createPaidOrder(1);
    const first = await adapter.reserveExactVariants(request);
    const replay = await adapter.reserveExactVariants(request);
    expect(first.outcome).toBe("reserved");
    expect(replay).toEqual(first);
    const stock = await pool.query<{ reserved_quantity: number }>(
      "SELECT reserved_quantity FROM branch_inventory WHERE merchant_id=$1 AND branch_id=$2 AND product_variant_id=$3",
      [merchantId, branchId, variantId]
    );
    expect(stock.rows[0]?.reserved_quantity).toBe(1);
  });

  it("rejects stale inventory snapshots at reservation time", async () => {
    const request = await createPaidOrder(1);
    await pool.query(
      "UPDATE branch_inventory SET last_synced_at = now() - interval '31 minutes' WHERE merchant_id=$1 AND branch_id=$2 AND product_variant_id=$3",
      [merchantId, branchId, variantId]
    );
    const result = await adapter.reserveExactVariants(request);
    expect(result).toEqual({ outcome: "unavailable", unavailableLines: [variantId] });
  });

  it("rejects low-confidence inventory at reservation time", async () => {
    const request = await createPaidOrder(1);
    await pool.query(
      "UPDATE branch_inventory SET availability_confidence = 'low' WHERE merchant_id=$1 AND branch_id=$2 AND product_variant_id=$3",
      [merchantId, branchId, variantId]
    );
    const result = await adapter.reserveExactVariants(request);
    expect(result).toEqual({ outcome: "unavailable", unavailableLines: [variantId] });
  });

  it("rejects reservations for an inactive branch", async () => {
    const request = await createPaidOrder(1);
    await pool.query("UPDATE merchant_branches SET status='inactive' WHERE merchant_id=$1 AND id=$2", [merchantId, branchId]);
    const result = await adapter.reserveExactVariants(request);
    expect(result).toEqual({ outcome: "unavailable", unavailableLines: [variantId] });
  });

  it("rejects reservations for a suspended merchant", async () => {
    const request = await createPaidOrder(1);
    await pool.query("UPDATE merchants SET status='suspended' WHERE id=$1", [merchantId]);
    const result = await adapter.reserveExactVariants(request);
    expect(result).toEqual({ outcome: "unavailable", unavailableLines: [variantId] });
  });

  it("does not oversell when two paid orders reserve the final unit concurrently", async () => {
    const [a, b] = await Promise.all([createPaidOrder(1), createPaidOrder(1)]);
    const results = await Promise.all([
      adapter.reserveExactVariants(a),
      adapter.reserveExactVariants(b)
    ]);
    expect(results.filter(result => result.outcome === "reserved")).toHaveLength(1);
    expect(results.filter(result => result.outcome === "unavailable")).toHaveLength(1);
    const stock = await pool.query<{ reserved_quantity: number }>(
      "SELECT reserved_quantity FROM branch_inventory WHERE merchant_id=$1 AND branch_id=$2 AND product_variant_id=$3",
      [merchantId, branchId, variantId]
    );
    expect(stock.rows[0]?.reserved_quantity).toBe(1);
  });

  it("publishes a targeted fulfillment task only for its exact merchant suborder", async () => {
    const request = await createPaidOrder(1);
    const task: ScheduledFulfillmentTaskEnvelope = {
      idempotencyKey: "scheduled-fulfillment:" + request.orderId + ":suborder:" +
        request.suborderId + ":merchant_preparation:v1",
      orderId: request.orderId,
      taskType: "merchant_preparation",
      executeAtUtc: "2026-11-08T10:00:00.000Z",
      plan: {
        orderId: request.orderId, fulfillmentType: "store_pickup",
        scheduledFor: "2026-11-08T13:00:00+03:00",
        scheduledForUtc: "2026-11-08T10:00:00.000Z",
        paymentDueAt: request.requestedAtUtc,
        inventoryReservationDueAt: request.requestedAtUtc,
        preparationReleaseAtUtc: "2026-11-08T10:00:00.000Z",
        estimate: { preparationMinutes: 60, bufferMinutes: 0, travelMinutes: 0 },
        createdAt: request.requestedAtUtc
      },
      target: {
        merchantTenantId: request.tenantId,
        suborderId: request.suborderId,
        merchantId: request.merchantId,
        branchId: request.branchId
      }
    };
    await inboxPublisher.publish(task, task.idempotencyKey);
    await inboxPublisher.publish(task, task.idempotencyKey);
    const inbox = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM scheduled_task_inbox WHERE order_id = $1",
      [request.orderId]
    );
    expect(inbox.rows[0]?.count).toBe("1");
    await expect(inboxPublisher.publish({
      ...task, target: { ...task.target!, branchId: "wrong-branch" }
    }, task.idempotencyKey)).rejects.toThrow("scheduled_inbox_target_not_found");
  });

  it("releases an allocation once and restores available stock", async () => {
    const request = await createPaidOrder(1);
    const reservation = await adapter.reserveExactVariants(request);
    if (reservation.outcome !== "reserved") throw new Error("expected reservation");
    const released = await lifecycle.release({
      tenantId, merchantId, branchId, reservationId: reservation.reservationReference,
      nowUtc: new Date().toISOString(), reason: "customer_cancelled"
    });
    expect(released).toEqual({ outcome: "updated", status: "released" });
    await expect(lifecycle.release({
      tenantId, merchantId, branchId, reservationId: reservation.reservationReference,
      nowUtc: new Date().toISOString(), reason: "customer_cancelled"
    })).resolves.toEqual({ outcome: "already_finalized", status: "released" });
    const stock = await pool.query<{ available_quantity: number; reserved_quantity: number }>(
      "SELECT available_quantity, reserved_quantity FROM branch_inventory WHERE merchant_id=$1 AND branch_id=$2 AND product_variant_id=$3",
      [merchantId, branchId, variantId]
    );
    expect(stock.rows[0]).toEqual({ available_quantity: 1, reserved_quantity: 0 });
  });

  it("consumes a reservation exactly once when the item is handed over", async () => {
    const request = await createPaidOrder(1);
    const reservation = await adapter.reserveExactVariants(request);
    if (reservation.outcome !== "reserved") throw new Error("expected reservation");
    await expect(lifecycle.consume({
      tenantId, merchantId, branchId, reservationId: reservation.reservationReference,
      nowUtc: new Date().toISOString(), handoverVerified: false, handoverReference: ""
    })).rejects.toThrow("inventory_reservation_handover_proof_required");
    const consumed = await lifecycle.consume({
      tenantId, merchantId, branchId, reservationId: reservation.reservationReference,
      nowUtc: new Date().toISOString(), handoverVerified: true,
      handoverReference: "handover-proof-" + randomUUID()
    });
    expect(consumed).toEqual({ outcome: "updated", status: "consumed" });
    await expect(lifecycle.consume({
      tenantId, merchantId, branchId, reservationId: reservation.reservationReference,
      nowUtc: new Date().toISOString(), handoverVerified: true,
      handoverReference: "handover-proof-" + randomUUID()
    })).resolves.toEqual({ outcome: "already_finalized", status: "consumed" });
    const stock = await pool.query<{ available_quantity: number; reserved_quantity: number }>(
      "SELECT available_quantity, reserved_quantity FROM branch_inventory WHERE merchant_id=$1 AND branch_id=$2 AND product_variant_id=$3",
      [merchantId, branchId, variantId]
    );
    expect(stock.rows[0]).toEqual({ available_quantity: 0, reserved_quantity: 0 });
  });

  it("expires only when the reservation deadline has passed", async () => {
    const request = await createPaidOrder(1);
    const reservation = await adapter.reserveExactVariants({
      ...request,
      requestedAtUtc: "2026-11-08T00:00:00.000Z",
      expiresAtUtc: "2026-11-08T00:01:00.000Z"
    });
    if (reservation.outcome !== "reserved") throw new Error("expected reservation");
    await expect(lifecycle.expire({
      tenantId, merchantId, branchId, reservationId: reservation.reservationReference,
      nowUtc: "2026-11-08T00:00:30.000Z"
    })).rejects.toThrow("inventory_reservation_not_expired");
    await expect(lifecycle.expire({
      tenantId, merchantId, branchId, reservationId: reservation.reservationReference,
      nowUtc: "2026-11-08T00:02:00.000Z"
    })).resolves.toEqual({ outcome: "updated", status: "expired" });
  });

  it("automatically expires due reservations and restores branch stock", async () => {
    const request = await createPaidOrder(1);
    const reservation = await adapter.reserveExactVariants({
      ...request,
      requestedAtUtc: "2026-11-08T00:00:00.000Z",
      expiresAtUtc: "2026-11-08T00:01:00.000Z"
    });
    if (reservation.outcome !== "reserved") throw new Error("expected reservation");
    const expiryWorker = new PostgresInventoryReservationExpiryWorker(pool, lifecycle);
    const result = await expiryWorker.runOnce({
      nowUtc: "2026-11-08T00:02:00.000Z",
      limit: 10
    });
    expect(result.expired).toBe(1);
    const stock = await pool.query<{ available_quantity: number; reserved_quantity: number }>(
      "SELECT available_quantity, reserved_quantity FROM branch_inventory WHERE merchant_id=$1 AND branch_id=$2 AND product_variant_id=$3",
      [merchantId, branchId, variantId]
    );
    expect(stock.rows[0]).toEqual({ available_quantity: 1, reserved_quantity: 0 });
  });

  it("rejects a request that does not match the persisted order line", async () => {
    const request = await createPaidOrder(1);
    await expect(adapter.reserveExactVariants({
      ...request, lines: [{ ...request.lines[0]!, quantity: 2 }]
    })).rejects.toThrow("inventory_reservation_order_lines_mismatch");
  });
});
