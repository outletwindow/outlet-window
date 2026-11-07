import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresBranchInventoryReservationAdapter } from "../../../packages/domain/src/postgres-branch-inventory-reservation.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgreSQL branch inventory reservations", () => {
  const configuredPool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 8 }) : null;
  if (!configuredPool) throw new Error("Pool must exist when DATABASE_URL is configured");
  const pool: Pool = configuredPool;
  const adapter = new PostgresBranchInventoryReservationAdapter(pool);
  const suffix = randomUUID();
  const merchantId = "inventory-merchant-" + suffix;
  const branchId = "inventory-branch-" + suffix;
  const variantId = "inventory-variant-" + suffix;
  const sku = "SKU-" + suffix;
  const tenantId = merchantId;
  const orderIds: string[] = [];
  const suborderIds: string[] = [];
  const reservationKeys: string[] = [];

  async function createPaidOrder(quantity: number) {
    const id = "inventory-order-" + randomUUID();
    const suborderId = "inventory-suborder-" + randomUUID();
    orderIds.push(id);
    suborderIds.push(suborderId);
    await pool.query(
      `INSERT INTO customer_orders
       (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
       VALUES ($1,'platform',$2,$3,'awaiting_payment','SAR',10000)`,
      [id, "inventory-customer-" + id, "inventory-idem-" + id]
    );
    await pool.query(
      `INSERT INTO scheduled_order_confirmations
       (order_id,tenant_id,payment_reference,payment_captured_at,confirmed_at,fulfillment_version)
       VALUES ($1,'platform',$2,now(),now(),1)`,
      [id, "payment-" + id]
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
    const idempotencyKey = "inventory-reservation:" + id + ":v1";
    reservationKeys.push(idempotencyKey);
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
    await pool.query("DELETE FROM inventory_reservation_lines WHERE reservation_id IN (SELECT id FROM inventory_reservations WHERE merchant_id = $1)", [merchantId]);
    await pool.query("DELETE FROM inventory_reservations WHERE merchant_id = $1", [merchantId]);
    await pool.query("DELETE FROM customer_order_items WHERE merchant_id = $1", [merchantId]);
    await pool.query("DELETE FROM scheduled_order_confirmations WHERE order_id = ANY($1::text[])", [orderIds]);
    await pool.query("DELETE FROM merchant_suborders WHERE merchant_id = $1", [merchantId]);
    await pool.query("DELETE FROM customer_orders WHERE id = ANY($1::text[])", [orderIds]);
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

  it("rejects a request that does not match the persisted order line", async () => {
    const request = await createPaidOrder(1);
    await expect(adapter.reserveExactVariants({
      ...request, lines: [{ ...request.lines[0]!, quantity: 2 }]
    })).rejects.toThrow("inventory_reservation_order_lines_mismatch");
  });
});
