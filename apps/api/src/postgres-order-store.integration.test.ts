import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresOrderStore } from "../../../packages/domain/src/postgres-order-store.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgresOrderStore marketplace tenancy", () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 3 }) : null;
  if (!pool) throw new Error("Pool must exist when DATABASE_URL is configured");
  const suffix = randomUUID();
  const merchantA = "order-merchant-a-" + suffix;
  const merchantB = "order-merchant-b-" + suffix;
  const branchA = "order-branch-a-" + suffix;
  const branchB = "order-branch-b-" + suffix;
  const orderId = "order-" + suffix;
  const customerId = "customer-" + suffix;
  const store = new PostgresOrderStore(pool);

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO merchants (id,legal_name,display_name,country_code,status) VALUES ($1,'Merchant A LLC','Merchant A','SA','active'),($2,'Merchant B LLC','Merchant B','SA','active')",
      [merchantA, merchantB]
    );
    await pool.query(
      "INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status) VALUES ($1,$2,'Branch A','JUB','active'),($3,$4,'Branch B','JUB','active')",
      [branchA, merchantA, branchB, merchantB]
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM customer_order_items WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM merchant_suborders WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM customer_orders WHERE id = $1", [orderId]);
    await pool.query("DELETE FROM merchant_branches WHERE merchant_id = ANY($1::text[])", [[merchantA, merchantB]]);
    await pool.query("DELETE FROM merchants WHERE id = ANY($1::text[])", [[merchantA, merchantB]]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::text[])", [[merchantA, merchantB]]);
    await pool.end();
  });

  const input = () => ({
    id: orderId, tenantId: "platform", customerId, idempotencyKey: "idem-" + suffix,
    currency: "SAR", totalMinor: 50000,
    suborders: [
      {
        id: "sub-a-" + suffix, merchantId: merchantA, branchId: branchA,
        status: "pending_validation" as const, subtotalMinor: 20000,
        items: [{ id: "item-a-" + suffix, productVariantId: "variant-a-" + suffix,
          sku: "SKU-A-" + suffix, quantity: 2, unitPriceMinor: 10000, currency: "SAR" }]
      },
      {
        id: "sub-b-" + suffix, merchantId: merchantB, branchId: branchB,
        status: "pending_validation" as const, subtotalMinor: 30000,
        items: [{ id: "item-b-" + suffix, productVariantId: "variant-b-" + suffix,
          sku: "SKU-B-" + suffix, quantity: 1, unitPriceMinor: 30000, currency: "SAR" }]
      }
    ]
  });

  it("creates one platform parent with merchant-scoped suborders and order lines", async () => {
    await expect(store.create(input())).resolves.toEqual({ outcome: "created", orderId });
    const parent = await pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM customer_orders WHERE id = $1", [orderId]
    );
    expect(parent.rows[0]?.tenant_id).toBe("platform");
    const children = await pool.query<{ tenant_id: string; merchant_id: string }>(
      "SELECT tenant_id, merchant_id FROM merchant_suborders WHERE order_id = $1 ORDER BY merchant_id",
      [orderId]
    );
    expect(children.rows).toEqual([
      { tenant_id: merchantA, merchant_id: merchantA },
      { tenant_id: merchantB, merchant_id: merchantB }
    ]);
    const lines = await pool.query<{ tenant_id: string; suborder_id: string; merchant_id: string; sku: string; quantity: number }>(
      "SELECT tenant_id, suborder_id, merchant_id, sku, quantity FROM customer_order_items WHERE order_id = $1 ORDER BY merchant_id",
      [orderId]
    );
    expect(lines.rows).toEqual([
      { tenant_id: merchantA, suborder_id: "sub-a-" + suffix, merchant_id: merchantA, sku: "SKU-A-" + suffix, quantity: 2 },
      { tenant_id: merchantB, suborder_id: "sub-b-" + suffix, merchant_id: merchantB, sku: "SKU-B-" + suffix, quantity: 1 }
    ]);
  });

  it("returns already_exists for an identical idempotent retry", async () => {
    await expect(store.create(input())).resolves.toEqual({ outcome: "already_exists", orderId });
  });

  it("returns idempotency_conflict when the same key is reused for different order data", async () => {
    await expect(store.create({ ...input(), totalMinor: 51000 })).resolves.toEqual({
      outcome: "idempotency_conflict", orderId
    });
  });

  it("rolls back the parent if any merchant branch is unavailable", async () => {
    const failedId = "failed-order-" + suffix;
    await expect(store.create({
      ...input(), id: failedId, idempotencyKey: "failed-" + suffix,
      suborders: [{
        id: "failed-sub-" + suffix, merchantId: merchantA, branchId: "missing-branch",
        status: "pending_validation", subtotalMinor: 1,
        items: [{ id: "failed-item-" + suffix, productVariantId: "failed-variant-" + suffix,
          sku: "FAILED-" + suffix, quantity: 1, unitPriceMinor: 1, currency: "SAR" }]
      }]
    })).rejects.toThrow("Merchant branch is unavailable for order creation");
    const parent = await pool.query("SELECT id FROM customer_orders WHERE id = $1", [failedId]);
    expect(parent.rowCount).toBe(0);
  });
});
