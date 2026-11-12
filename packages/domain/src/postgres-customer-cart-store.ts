import { randomUUID } from "node:crypto";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";

export type CustomerCartItem = {
  id: string; merchantId: string; branchId: string; productVariantId: string;
  quantity: number; title: string; sku: string | null; currency: string | null; priceMinor: number | null;
  inStock: boolean;
};
export type CustomerCart = {
  id: string; customerId: string; currency: string | null; version: number;
  items: CustomerCartItem[];
};

type CartRow = { id: string; customer_id: string; currency: string | null; version: number };
type ItemRow = {
  id: string; merchant_id: string; branch_id: string; product_variant_id: string;
  quantity: number; title: string; sku: string | null; currency: string | null;
  price_minor: string | number | null; in_stock: boolean;
};
const PLATFORM_TENANT = "platform";

function safeMinor(value: string | number | null): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Durable customer-owned cart. Prices are display snapshots only; order creation must reprice server-side. */
export class PostgresCustomerCartStore {
  constructor(private readonly pool: PostgresPool, private readonly createId: () => string = randomUUID) {}

  async get(input: { customerId: string }): Promise<CustomerCart | null> {
    if (!input.customerId.trim()) throw new Error("invalid_customer_cart_owner");
    const cart = await this.pool.query<CartRow>(
      "SELECT id, customer_id, currency, version FROM customer_carts WHERE tenant_id=$1 AND customer_id=$2 AND status='active'",
      [PLATFORM_TENANT, input.customerId]
    );
    const row = cart.rows[0];
    if (!row) return null;
    return this.readItems(row);
  }

  async addItem(input: {
    customerId: string; merchantId: string; branchId: string; productVariantId: string; quantity: number;
  }): Promise<CustomerCart> {
    if (!input.customerId.trim() || !input.merchantId.trim() || !input.branchId.trim() ||
        !input.productVariantId.trim() || !Number.isSafeInteger(input.quantity) ||
        input.quantity < 1 || input.quantity > 99) throw new Error("invalid_customer_cart_item");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["customer-cart:" + input.customerId]);
      const eligible = await client.query<{ merchant_tenant_id: string; currency: string; price_minor: string | number }>(
        `SELECT m.tenant_id AS merchant_tenant_id, COALESCE(v.currency,p.currency) AS currency,
                COALESCE(v.price_minor,p.price_minor) AS price_minor
         FROM merchants m
         JOIN merchant_branches b ON b.merchant_id=m.id
         JOIN commerce_catalog_variants v ON v.id=$3 AND v.tenant_id=m.tenant_id
         JOIN commerce_catalog_products p ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         JOIN branch_inventory i ON i.merchant_id=m.id AND i.branch_id=b.id
           AND i.product_variant_id=v.external_variant_id AND i.sku=v.sku
         WHERE m.id=$1 AND b.id=$2 AND m.status='active' AND b.status='active'
           AND p.published_at IS NOT NULL AND v.sku IS NOT NULL
           AND COALESCE(v.currency,p.currency) IS NOT NULL
           AND COALESCE(v.price_minor,p.price_minor) IS NOT NULL
           AND i.last_synced_at >= clock_timestamp()-interval '30 minutes'
           AND i.availability_confidence IN ('high','medium')
           AND i.available_quantity-i.reserved_quantity >= $4
         FOR UPDATE OF m,b,i`,
        [input.merchantId,input.branchId,input.productVariantId,input.quantity]
      );
      const product = eligible.rows[0];
      if (!product) throw new Error("customer_cart_variant_unavailable");
      const minor = safeMinor(product.price_minor);
      if (minor === null || !/^[A-Z]{3}$/.test(product.currency)) throw new Error("customer_cart_variant_unpriced");
      const cart = await client.query<CartRow>(
        `INSERT INTO customer_carts (id,tenant_id,customer_id,status,currency)
         VALUES ($1,$2,$3,'active',$4)
         ON CONFLICT (tenant_id,customer_id) WHERE status='active'
         DO UPDATE SET updated_at=clock_timestamp()
         RETURNING id,customer_id,currency,version`,
        [this.createId(),PLATFORM_TENANT,input.customerId,product.currency]
      );
      const cartRow = cart.rows[0];
      if (!cartRow) throw new Error("customer_cart_persistence_failed");
      if (cartRow.currency !== product.currency) throw new Error("customer_cart_currency_mismatch");
      const existing = await client.query<{ quantity: number }>(
        "SELECT quantity FROM customer_cart_items WHERE cart_id=$1 AND merchant_id=$2 AND branch_id=$3 AND product_variant_id=$4 FOR UPDATE",
        [cartRow.id,input.merchantId,input.branchId,input.productVariantId]
      );
      const totalQuantity = (existing.rows[0]?.quantity ?? 0) + input.quantity;
      if (totalQuantity > 99) throw new Error("customer_cart_quantity_limit");
      if (totalQuantity > input.quantity) {
        const stock = await client.query<{ available: boolean }>(
          `SELECT (i.available_quantity-i.reserved_quantity >= $4) AS available
           FROM branch_inventory i WHERE i.merchant_id=$1 AND i.branch_id=$2
             AND i.product_variant_id=(SELECT external_variant_id FROM commerce_catalog_variants WHERE id=$3)`,
          [input.merchantId,input.branchId,input.productVariantId,totalQuantity]
        );
        if (stock.rows[0]?.available !== true) throw new Error("customer_cart_variant_unavailable");
      }
      await client.query(
        `INSERT INTO customer_cart_items (id,tenant_id,cart_id,merchant_tenant_id,merchant_id,branch_id,product_variant_id,quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (cart_id,merchant_id,branch_id,product_variant_id)
         DO UPDATE SET quantity=EXCLUDED.quantity,updated_at=clock_timestamp()`,
        [this.createId(),PLATFORM_TENANT,cartRow.id,product.merchant_tenant_id,input.merchantId,input.branchId,input.productVariantId,totalQuantity]
      );
      await client.query("UPDATE customer_carts SET version=version+1,updated_at=clock_timestamp() WHERE id=$1",[cartRow.id]);
      await client.query("COMMIT");
      return (await this.readCart(client,input.customerId))!;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async removeItem(input: { customerId: string; itemId: string }): Promise<CustomerCart | null> {
    if (!input.customerId.trim() || !input.itemId.trim()) throw new Error("invalid_customer_cart_item");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const removed = await client.query<{ cart_id: string }>(
        `DELETE FROM customer_cart_items i USING customer_carts c
         WHERE i.id=$1 AND i.cart_id=c.id AND c.tenant_id=$2
           AND c.customer_id=$3 AND c.status='active' RETURNING c.id AS cart_id`,
        [input.itemId,PLATFORM_TENANT,input.customerId]
      );
      if (removed.rowCount) await client.query(
        "UPDATE customer_carts SET version=version+1,updated_at=clock_timestamp() WHERE id=$1",
        [removed.rows[0]!.cart_id]
      );
      const cart = await this.readCart(client,input.customerId);
      await client.query("COMMIT");
      return cart;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async readCart(queryable: PostgresClient | PostgresPool, customerId: string): Promise<CustomerCart | null> {
    const result = await queryable.query<CartRow>(
      "SELECT id,customer_id,currency,version FROM customer_carts WHERE tenant_id=$1 AND customer_id=$2 AND status='active'",
      [PLATFORM_TENANT,customerId]
    );
    return result.rows[0] ? this.readItems(result.rows[0],queryable) : null;
  }

  private async readItems(cart: CartRow, queryable: PostgresClient | PostgresPool = this.pool): Promise<CustomerCart> {
    const result = await queryable.query<ItemRow>(
      `SELECT ci.id,ci.merchant_id,ci.branch_id,ci.product_variant_id,ci.quantity,p.title,v.sku,
              COALESCE(v.currency,p.currency) AS currency,
              COALESCE(v.price_minor,p.price_minor) AS price_minor,
              (m.status='active' AND b.status='active' AND p.published_at IS NOT NULL
               AND i.last_synced_at >= clock_timestamp()-interval '30 minutes'
               AND i.availability_confidence IN ('high','medium')
               AND i.available_quantity-i.reserved_quantity >= ci.quantity) AS in_stock
       FROM customer_cart_items ci
       JOIN commerce_catalog_variants v ON v.id=ci.product_variant_id
       JOIN commerce_catalog_products p ON p.id=v.product_id AND p.tenant_id=v.tenant_id
       JOIN merchants m ON m.id=ci.merchant_id AND m.tenant_id=v.tenant_id
       JOIN merchant_branches b ON b.merchant_id=m.id AND b.id=ci.branch_id
       LEFT JOIN branch_inventory i ON i.merchant_id=m.id AND i.branch_id=b.id
         AND i.product_variant_id=v.external_variant_id AND i.sku=v.sku
       WHERE ci.tenant_id=$1 AND ci.cart_id=$2
       ORDER BY ci.created_at,ci.id`,
      [PLATFORM_TENANT,cart.id]
    );
    return { id:cart.id,customerId:cart.customer_id,currency:cart.currency,version:cart.version,
      items:result.rows.map(item=>({id:item.id,merchantId:item.merchant_id,branchId:item.branch_id,
        productVariantId:item.product_variant_id,quantity:item.quantity,title:item.title,sku:item.sku,
        currency:item.currency,priceMinor:safeMinor(item.price_minor),
        inStock:item.in_stock === true})) };
  }
}
