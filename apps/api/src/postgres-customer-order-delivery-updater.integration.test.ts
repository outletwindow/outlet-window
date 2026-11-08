import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresCustomerOrderDeliveryUpdater } from "../../../packages/domain/src/postgres-customer-order-delivery-updater.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgreSQL customer delivery destination updater", () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 3 }) : null;
  if (!pool) throw new Error("Pool must exist when DATABASE_URL is configured");
  const now = new Date("2026-11-08T12:00:02.000Z");
  const updater = new PostgresCustomerOrderDeliveryUpdater(pool, () => now);
  const suffix = randomUUID();
  const tenantId = "platform";
  const customerId = "delivery-customer-" + suffix;
  const orderId = "delivery-order-" + suffix;

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO customer_orders
       (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
       VALUES ($1,$2,$3,$4,'confirmed','SAR',50000)`,
      [orderId, tenantId, customerId, "delivery-order-idem-" + suffix]
    );
    await pool.query(
      `INSERT INTO scheduled_order_confirmations
       (order_id,tenant_id,payment_reference,payment_captured_at,confirmed_at,fulfillment_version)
       VALUES ($1,$2,$3,'2026-11-08T12:00:00Z','2026-11-08T12:00:01Z',1)`,
      [orderId, tenantId, "delivery-payment-" + suffix]
    );
  });

  afterEach(async () => {
    await pool.query("DELETE FROM customer_order_edit_events WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM customer_orders WHERE id = $1", [orderId]);
  });
  afterAll(async () => { await pool.end(); });

  const baseInput = () => ({
    tenantId, customerId, orderId, actorId: customerId,
    destination: { latitude: 27.01, longitude: 49.65 },
    serviceArea: {
      id: "jubail-core", center: { latitude: 27.0046, longitude: 49.646 }, radiusMeters: 10_000
    },
    quote: {
      branchId: "branch-new", deliveryFeeMinor: 1500, totalMinor: 51500,
      currency: "SAR", estimatedDeliveryAtUtc: "2026-11-08T13:00:00.000Z",
      quoteReference: "delivery-quote-" + suffix, expiresAtUtc: "2026-11-08T12:05:00.000Z"
    }
  });

  it("persists destination, repriced total, new branch and append-only event atomically", async () => {
    const result = await updater.update(baseInput());
    expect(result).toMatchObject({ outcome: "updated", branchChanged: true });
    const order = await pool.query(
      "SELECT delivery_destination,delivery_quote,delivery_zone_id,delivery_branch_id,total_minor FROM customer_orders WHERE id = $1",
      [orderId]
    );
    expect(order.rows[0]).toMatchObject({
      delivery_destination: { latitude: 27.01, longitude: 49.65 },
      delivery_zone_id: "jubail-core", delivery_branch_id: "branch-new", total_minor: "51500"
    });
    const events = await pool.query(
      "SELECT edit_type,quote_reference FROM customer_order_edit_events WHERE order_id = $1", [orderId]
    );
    expect(events.rows).toEqual([{ edit_type: "delivery_destination", quote_reference: "delivery-quote-" + suffix }]);
  });

  it("rejects a destination outside the service area without changing the order", async () => {
    const result = await updater.update({
      ...baseInput(), destination: { latitude: 27.2, longitude: 49.65 }
    });
    expect(result).toEqual({ outcome: "outside_service_area" });
    const order = await pool.query(
      "SELECT delivery_destination,total_minor FROM customer_orders WHERE id = $1", [orderId]
    );
    expect(order.rows[0]).toEqual({ delivery_destination: null, total_minor: "50000" });
  });

  it("rejects edits after the five-second window without changing the order", async () => {
    const lateUpdater = new PostgresCustomerOrderDeliveryUpdater(pool, () => new Date("2026-11-08T12:00:06.000Z"));
    expect(await lateUpdater.update(baseInput())).toEqual({ outcome: "edit_window_expired" });
  });
});
