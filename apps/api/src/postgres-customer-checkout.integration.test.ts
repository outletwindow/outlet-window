import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresCustomerCheckoutService } from "../../../packages/domain/src/postgres-customer-checkout.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgreSQL customer checkout orchestration", () => {
  const configuredPool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 4 }) : null;
  if (!configuredPool) throw new Error("Pool must exist when DATABASE_URL is configured");
  const pool: Pool = configuredPool;
  let suffix: string;
  let customerId: string;
  let merchantId: string;
  let branchId: string;
  let integrationId: string;
  let productId: string;
  let variantId: string;
  let cartId: string;
  let cartItemId: string;
  let areaId: string;
  let ruleId: string;
  let correlationId: string;
  const orderIds: string[] = [];

  beforeEach(async () => {
    suffix = randomUUID();
    customerId = "checkout-customer-" + suffix;
    merchantId = "checkout-merchant-" + suffix;
    branchId = "checkout-branch-" + suffix;
    integrationId = "checkout-integration-" + suffix;
    productId = "checkout-product-" + suffix;
    variantId = "checkout-variant-" + suffix;
    cartId = "checkout-cart-" + suffix;
    cartItemId = "checkout-cart-item-" + suffix;
    areaId = "checkout-area-" + suffix;
    ruleId = "checkout-rule-" + suffix;
    correlationId = "checkout-correlation-" + suffix;
    orderIds.length = 0;
    const now = new Date();
    await pool.query(
      `INSERT INTO identities (id,principal_type,status,display_name,primary_email,created_at,updated_at)
       VALUES ($1,'human','active','Checkout Customer',$2,$3,$3)`,
      [customerId, customerId + "@example.test", now]
    );
    await pool.query(
      `INSERT INTO merchants (id,legal_name,display_name,country_code,status)
       VALUES ($1,'Checkout Merchant LLC','Checkout Merchant','SA','active')`,
      [merchantId]
    );
    await pool.query(
      `INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,address,status,latitude,longitude)
       VALUES ($1,$2,'Checkout Branch','JUBAIL','{}'::jsonb,'active',27.010000,49.650000)`,
      [branchId, merchantId]
    );
    await pool.query(
      `INSERT INTO tenant_integrations
       (id,tenant_id,family,provider_key,display_name,status,created_at,updated_at)
       VALUES ($1,$2,'commerce','manual','Checkout Test Catalog','connected',now(),now())`,
      [integrationId, merchantId]
    );
    await pool.query(
      `INSERT INTO commerce_catalog_products
       (id,tenant_id,integration_id,provider_key,external_product_id,canonical_url,title,
        currency,price_minor,source_type,source_captured_at,source_content_sha256,published_at)
       VALUES ($1,$2,$3,'manual',$4,'https://catalog.example.test/checkout-product',
        'Checkout Test Product','SAR',2000,'manual',now(),repeat('b',64),now())`,
      [productId, merchantId, integrationId, "external-product-" + suffix]
    );
    await pool.query(
      `INSERT INTO commerce_catalog_variants
       (id,tenant_id,product_id,external_variant_id,sku,currency,price_minor)
       VALUES ($1,$2,$3,$4,$5,'SAR',2000)`,
      [variantId, merchantId, productId, "external-variant-" + suffix, "CHECKOUT-SKU-" + suffix]
    );
    await pool.query(
      `INSERT INTO branch_inventory
       (merchant_id,branch_id,product_variant_id,sku,available_quantity,reserved_quantity,
        source,last_synced_at,availability_confidence)
       VALUES ($1,$2,$3,$4,10,0,'manual',now(),'high')`,
      [merchantId, branchId, "external-variant-" + suffix, "CHECKOUT-SKU-" + suffix]
    );
    await pool.query(
      `INSERT INTO customer_carts (id,tenant_id,customer_id,status,currency,version)
       VALUES ($1,'platform',$2,'active','SAR',2)`,
      [cartId, customerId]
    );
    await pool.query(
      `INSERT INTO customer_cart_items
       (id,tenant_id,cart_id,merchant_tenant_id,merchant_id,branch_id,product_variant_id,quantity)
       VALUES ($1,'platform',$2,$3,$4,$5,$6,1)`,
      [cartItemId, cartId, merchantId, merchantId, branchId, variantId]
    );
    await pool.query(
      `INSERT INTO delivery_service_areas
       (id,tenant_id,country_code,city_code,display_name,center_latitude,center_longitude,
        radius_meters,currency,status,effective_from,created_by)
       VALUES ($1,'platform','SA','JUBAIL','Checkout Test Area',27.010000,49.650000,
        10000,'SAR','active',now()-interval '1 minute','checkout-test')`,
      [areaId]
    );
    await pool.query(
      `INSERT INTO delivery_service_area_branches (tenant_id,service_area_id,merchant_id,branch_id)
       VALUES ('platform',$1,$2,$3)`,
      [areaId, merchantId, branchId]
    );
    await pool.query(
      `INSERT INTO delivery_pricing_rules
       (id,tenant_id,service_area_id,version,service_code,currency,calculation_config,status,
        effective_from,created_by,approved_by,approved_at)
       VALUES ($1,'platform',$2,1,'standard_delivery','SAR',
        '{"method":"fixed_plus_distance","base_fee_minor":1500,"per_km_minor":0}'::jsonb,
        'active',now()-interval '1 minute','checkout-test','checkout-approver',now())`,
      [ruleId, areaId]
    );
  });

  async function cleanup() {
    // Delivery quote snapshots are intentionally append-only and retain their
    // suborder FK. Keep the successful checkout fixture intact; each test receives
    // a fresh UUID namespace so no later test can collide with these durable rows.
    const immutableQuotes = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM customer_order_suborder_delivery_quotes WHERE order_id = ANY($1::text[])",
      [orderIds]
    );
    if (immutableQuotes.rows[0]?.count !== "0") return;
    await pool.query("DELETE FROM customer_order_items WHERE order_id = ANY($1::text[])", [orderIds]);
    await pool.query("DELETE FROM merchant_suborders WHERE order_id = ANY($1::text[])", [orderIds]);
    await pool.query("DELETE FROM customer_orders WHERE id = ANY($1::text[])", [orderIds]);
    await pool.query("DELETE FROM customer_cart_items WHERE cart_id=$1", [cartId]);
    await pool.query("DELETE FROM customer_carts WHERE id=$1", [cartId]);
    await pool.query("DELETE FROM delivery_pricing_rules WHERE tenant_id='platform' AND id=$1", [ruleId]);
    await pool.query("DELETE FROM delivery_service_area_branches WHERE tenant_id='platform' AND service_area_id=$1", [areaId]);
    await pool.query("DELETE FROM delivery_service_areas WHERE tenant_id='platform' AND id=$1", [areaId]);
    await pool.query("DELETE FROM branch_inventory WHERE merchant_id=$1", [merchantId]);
    await pool.query("DELETE FROM commerce_catalog_products WHERE tenant_id=$1", [merchantId]);
    await pool.query("DELETE FROM tenant_integrations WHERE tenant_id=$1", [merchantId]);
    await pool.query("DELETE FROM merchant_branches WHERE merchant_id=$1", [merchantId]);
    await pool.query("DELETE FROM merchants WHERE id=$1", [merchantId]);
    await pool.query("DELETE FROM tenants WHERE id=$1 AND tenant_type='merchant'", [merchantId]);
    await pool.query("DELETE FROM identities WHERE id=$1", [customerId]);
  }

  afterEach(cleanup);
  afterAll(async () => { await pool.end(); });

  it("leaves the cart and order tables unchanged when the active delivery rule is unavailable", async () => {
    await pool.query(
      "UPDATE delivery_pricing_rules SET status='suspended' WHERE tenant_id='platform' AND id=$1",
      [ruleId]
    );
    const service = new PostgresCustomerCheckoutService(pool, randomUUID);
    const result = await service.create({
      customerId, expectedCartVersion: 2, idempotencyKey: "checkout-no-rule-" + suffix,
      destination: { countryCode: "SA", cityCode: "JUBAIL", serviceCode: "standard_delivery",
        latitude: 27.010000, longitude: 49.650000 },
      actorId: "checkout-system", actorRole: "system", correlationId
    });
    expect(result).toEqual({ outcome: "no_active_pricing_rule" });
    const cart = await pool.query<{ status: string; version: number }>(
      "SELECT status,version FROM customer_carts WHERE id=$1", [cartId]
    );
    expect(cart.rows).toEqual([{ status: "active", version: 2 }]);
    const orders = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM customer_orders WHERE customer_id=$1", [customerId]
    );
    expect(orders.rows[0]?.count).toBe("0");
  });

  it("creates order, persists delivery and pricing snapshots, transitions readiness, and converts cart atomically", async () => {
    const service = new PostgresCustomerCheckoutService(pool, randomUUID);
    const checkoutInput = {
      customerId, expectedCartVersion: 2, idempotencyKey: "checkout-integration-" + suffix,
      destination: { countryCode: "SA", cityCode: "JUBAIL", serviceCode: "standard_delivery",
        latitude: 27.010000, longitude: 49.650000,
        addressSnapshot: { label: "Home", buildingNumber: "12" } },
      actorId: "checkout-system", actorRole: "system" as const, correlationId
    };
    const result = await service.create(checkoutInput);
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    orderIds.push(result.orderId);

    // A retry after a successful commit must resolve the same order even though
    // the original cart has already been converted and is no longer active.
    const replay = await service.create(checkoutInput);
    expect(replay).toMatchObject({ outcome: "created", orderId: result.orderId,
      totalMinor: result.totalMinor, currency: result.currency });

    // Reusing the key for a different delivery destination must fail closed.
    const conflictingReplay = await service.create({
      ...checkoutInput,
      destination: { ...checkoutInput.destination, latitude: 27.020000 }
    });
    expect(conflictingReplay).toEqual({ outcome: "idempotency_conflict" });

    const persistedOrderCount = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM customer_orders WHERE id=$1", [result.orderId]
    );
    expect(persistedOrderCount.rows[0]?.count).toBe("1");

    const parent = await pool.query<{
      status: string; currency: string; total_minor: string; delivery_zone_id: string;
      delivery_branch_id: string; delivery_quote: { totalMinor: number };
      metadata: { checkoutPricing: {
        components: Array<{ kind: string; amountMinor: number }>;
        checkoutRequest: { expectedCartVersion: number; destination: { latitude: number } };
      } };
    }>(
      `SELECT status,currency,total_minor,delivery_zone_id,delivery_branch_id,delivery_quote,metadata
       FROM customer_orders WHERE id=$1`, [result.orderId]
    );
    expect(parent.rows[0]?.status).toBe("awaiting_payment");
    expect(parent.rows[0]?.currency).toBe("SAR");
    expect(parent.rows[0]?.total_minor).toBe("3500");
    expect(parent.rows[0]?.delivery_zone_id).toBe(areaId);
    expect(parent.rows[0]?.delivery_branch_id).toBe(branchId);
    expect(parent.rows[0]?.delivery_quote.totalMinor).toBe(1500);
    expect(parent.rows[0]?.metadata.checkoutPricing.components).toHaveLength(2);
    expect(parent.rows[0]?.metadata.checkoutPricing.checkoutRequest).toMatchObject({
      expectedCartVersion: 2, destination: { latitude: 27.010000 }
    });

    const suborders = await pool.query<{ id: string; status: string; merchant_id: string; branch_id: string }>(
      "SELECT id,status,merchant_id,branch_id FROM merchant_suborders WHERE order_id=$1", [result.orderId]
    );
    expect(suborders.rows).toHaveLength(1);
    expect(suborders.rows[0]).toMatchObject({ status: "awaiting_payment", merchant_id: merchantId, branch_id: branchId });

    const cart = await pool.query<{ status: string; version: number }>(
      "SELECT status,version FROM customer_carts WHERE id=$1", [cartId]
    );
    expect(cart.rows).toEqual([{ status: "converted", version: 3 }]);

    const audit = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM audit_events WHERE correlation_id=$1 AND resource_id=$2",
      [correlationId, suborders.rows[0]?.id]
    );
    expect(audit.rows[0]?.count).toBe("1");

    const stock = await pool.query<{ reserved_quantity: number }>(
      "SELECT reserved_quantity FROM branch_inventory WHERE merchant_id=$1 AND branch_id=$2",
      [merchantId, branchId]
    );
    expect(stock.rows[0]?.reserved_quantity).toBe(0);
  });
});
