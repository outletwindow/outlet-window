import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresOrderStore, type CreateCustomerOrderInput } from "../../../packages/domain/src/postgres-order-store.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgreSQL customer order persistence", () => {
  const configuredPool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 4 }) : null;
  if (!configuredPool) throw new Error("Pool must exist when DATABASE_URL is configured");
  const pool: Pool = configuredPool;
  const store = new PostgresOrderStore(pool);
  const suffix = randomUUID();
  const merchantId = "order-store-merchant-" + suffix;
  const branchId = "order-store-branch-" + suffix;
  const orderIds: string[] = [];

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO merchants (id,legal_name,display_name,country_code,status)
       VALUES ($1,'Order Store Merchant LLC','Order Store Merchant','SA','active')`,
      [merchantId]
    );
    await pool.query(
      `INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
       VALUES ($1,$2,'Order Store Branch','DMM','active')`,
      [branchId,merchantId]
    );
  });

  async function cleanup() {
    await pool.query("DELETE FROM customer_order_items WHERE merchant_id=$1",[merchantId]);
    await pool.query("DELETE FROM merchant_suborders WHERE merchant_id=$1",[merchantId]);
    await pool.query("DELETE FROM customer_orders WHERE id = ANY($1::text[])",[orderIds]);
    await pool.query("DELETE FROM merchant_branches WHERE merchant_id=$1",[merchantId]);
    await pool.query("DELETE FROM merchants WHERE id=$1",[merchantId]);
  }

  afterEach(cleanup);
  afterAll(async () => { await pool.end(); });

  function input(): CreateCustomerOrderInput {
    const id = "order-store-order-" + randomUUID();
    orderIds.push(id);
    return {
      id, tenantId: "platform", customerId: "order-store-customer-" + suffix,
      idempotencyKey: "order-store-idempotency-" + randomUUID(),
      currency: "SAR", totalMinor: 12900, metadata: { channel: "integration-test" },
      suborders: [{
        id: "order-store-suborder-" + randomUUID(), merchantId, branchId,
        status: "pending_validation", subtotalMinor: 12900,
        items: [{
          id: "order-store-item-" + randomUUID(), productVariantId: "external-variant-" + suffix,
          sku: "ORDER-STORE-SKU-" + suffix, quantity: 2, unitPriceMinor: 6450, currency: "SAR"
        }]
      }]
    };
  }

  it("persists parent, merchant suborder, and immutable item lines and verifies exact idempotent replay", async () => {
    const request = input();
    await expect(store.create(request)).resolves.toEqual({ outcome: "created", orderId: request.id });
    const parent = await pool.query<{ tenant_id: string; total_minor: string }>(
      "SELECT tenant_id,total_minor FROM customer_orders WHERE id=$1",[request.id]
    );
    expect(parent.rows[0]).toEqual({ tenant_id: "platform", total_minor: "12900" });
    const suborders = await pool.query<{ tenant_id: string; merchant_id: string; branch_id: string }>(
      "SELECT tenant_id,merchant_id,branch_id FROM merchant_suborders WHERE order_id=$1",[request.id]
    );
    expect(suborders.rows).toEqual([{ tenant_id: merchantId, merchant_id: merchantId, branch_id: branchId }]);
    const items = await pool.query<{ quantity: number; unit_price_minor: string; sku: string }>(
      "SELECT quantity,unit_price_minor,sku FROM customer_order_items WHERE order_id=$1",[request.id]
    );
    expect(items.rows).toEqual([{ quantity: 2, unit_price_minor: "6450", sku: request.suborders[0]!.items[0]!.sku }]);
    await expect(store.create(request)).resolves.toEqual({ outcome: "already_exists", orderId: request.id });
    const changed = {
      ...request,
      totalMinor: 13000,
      suborders: [{ ...request.suborders[0]!, subtotalMinor: 13000,
        items: [{ ...request.suborders[0]!.items[0]!, unitPriceMinor: 6500 }] }]
    };
    await expect(store.create(changed)).resolves.toEqual({ outcome: "idempotency_conflict", orderId: request.id });
  });

  it("rolls back the parent order when the selected merchant branch is unavailable", async () => {
    const request = input();
    const invalid = {
      ...request,
      suborders: [{ ...request.suborders[0]!, branchId: "missing-branch-" + suffix }]
    };
    await expect(store.create(invalid)).rejects.toThrow("Merchant branch is unavailable for order creation");
    const parent = await pool.query("SELECT id FROM customer_orders WHERE id=$1",[request.id]);
    expect(parent.rowCount).toBe(0);
  });
});
