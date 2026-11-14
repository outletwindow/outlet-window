import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";

type CartHeader = { id: string; customer_id: string; currency: string | null; version: number };
type CartCount = { item_count: number | string };
type RepricingRow = {
  item_id: string; merchant_id: string; branch_id: string; merchant_tenant_id: string;
  product_variant_id: string; quantity: number; title: string; sku: string | null;
  currency: string | null; price_minor: string | number | null;
  merchant_active: boolean; branch_active: boolean; product_published: boolean;
  stock_eligible: boolean;
};

export interface RepricedCartLine {
  cartItemId: string; merchantId: string; branchId: string; merchantTenantId: string;
  productVariantId: string; title: string; sku: string; quantity: number;
  unitPriceMinor: number; lineTotalMinor: number; currency: string;
}
export interface RepricedCartSuborder {
  merchantId: string; branchId: string; merchantTenantId: string;
  items: readonly RepricedCartLine[]; subtotalMinor: number;
}
export type CustomerCartRepricingResult =
  | { outcome: "not_found" | "version_conflict" | "empty" }
  | { outcome: "unavailable"; reason: "inventory_or_catalog_mapping_missing" | "inventory_stale_or_insufficient" }
  | { outcome: "invalid_snapshot"; reason: "currency_mismatch" | "invalid_catalog_price" | "unsafe_total" }
  | {
      outcome: "priced"; cartId: string; customerId: string; cartVersion: number;
      currency: string; items: readonly RepricedCartLine[];
      suborders: readonly RepricedCartSuborder[]; subtotalMinor: number;
    };

function minor(value: string | number | null): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Produces an authoritative, locked price snapshot from the live catalog and branch stock.
 * Cart display prices are intentionally never read. The shared customer-cart advisory lock
 * serializes this operation with add/remove; row locks protect catalog and stock through the
 * this transaction. The returned snapshot is a preflight result only: it must not
 * be used to create an order after these locks are released. Final checkout must revalidate
 * and persist pricing in the same transaction that creates the order. This is not a public
 * checkout endpoint.
 */
export class PostgresCustomerCartRepricingService {
  constructor(private readonly pool: PostgresPool) {}

  async reprice(input: { customerId: string; expectedCartVersion: number }): Promise<CustomerCartRepricingResult> {
    if (!input.customerId.trim() || !Number.isSafeInteger(input.expectedCartVersion) ||
        input.expectedCartVersion < 1) throw new Error("invalid_customer_cart_repricing_request");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["customer-cart:" + input.customerId]);

      const headerResult = await client.query<CartHeader>(
        "SELECT id, customer_id, currency, version FROM customer_carts WHERE tenant_id=$1 AND customer_id=$2 AND status='active' FOR UPDATE",
        ["platform", input.customerId]
      );
      const cart = headerResult.rows[0];
      if (!cart) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      if (cart.version !== input.expectedCartVersion) {
        await client.query("ROLLBACK");
        return { outcome: "version_conflict" };
      }

      const countResult = await client.query<CartCount>(
        "SELECT COUNT(*)::int AS item_count FROM customer_cart_items WHERE tenant_id=$1 AND cart_id=$2",
        ["platform", cart.id]
      );
      const itemCount = Number(countResult.rows[0]?.item_count ?? 0);
      if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
        await client.query("ROLLBACK");
        return { outcome: "invalid_snapshot", reason: "unsafe_total" };
      }
      if (itemCount === 0) {
        await client.query("ROLLBACK");
        return { outcome: "empty" };
      }

      const linesResult = await client.query<RepricingRow>(
        `SELECT ci.id AS item_id, ci.merchant_id, ci.branch_id,
                ci.merchant_tenant_id, ci.product_variant_id, ci.quantity,
                p.title, v.sku, COALESCE(v.currency,p.currency) AS currency,
                COALESCE(v.price_minor,p.price_minor) AS price_minor,
                (m.status='active') AS merchant_active,
                (b.status='active') AS branch_active,
                (p.published_at IS NOT NULL) AS product_published,
                (i.last_synced_at >= clock_timestamp()-interval '30 minutes'
                  AND i.availability_confidence IN ('high','medium')
                  AND i.available_quantity-i.reserved_quantity >= ci.quantity) AS stock_eligible
         FROM customer_cart_items ci
         JOIN commerce_catalog_variants v
           ON v.tenant_id=ci.merchant_tenant_id AND v.id=ci.product_variant_id
         JOIN commerce_catalog_products p
           ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         JOIN merchants m
           ON m.tenant_id=ci.merchant_tenant_id AND m.id=ci.merchant_id
         JOIN merchant_branches b
           ON b.merchant_id=ci.merchant_id AND b.id=ci.branch_id
         JOIN branch_inventory i
           ON i.merchant_id=ci.merchant_id AND i.branch_id=ci.branch_id
          AND i.product_variant_id=v.external_variant_id AND i.sku=v.sku
         WHERE ci.tenant_id=$1 AND ci.cart_id=$2
         ORDER BY ci.merchant_id,ci.branch_id,ci.product_variant_id
         FOR UPDATE OF ci,v,p,m,b,i`,
        ["platform", cart.id]
      );

      if (linesResult.rows.length !== itemCount) {
        await client.query("ROLLBACK");
        return { outcome: "unavailable", reason: "inventory_or_catalog_mapping_missing" };
      }
      if (linesResult.rows.some(row => !row.merchant_active || !row.branch_active || !row.product_published || !row.stock_eligible)) {
        await client.query("ROLLBACK");
        return { outcome: "unavailable", reason: "inventory_stale_or_insufficient" };
      }

      if (!cart.currency || !/^[A-Z]{3}$/.test(cart.currency)) {
        await client.query("ROLLBACK");
        return { outcome: "invalid_snapshot", reason: "currency_mismatch" };
      }

      const items: RepricedCartLine[] = [];
      const groups = new Map<string, { merchantId: string; branchId: string; merchantTenantId: string; items: RepricedCartLine[]; subtotalMinor: number }>();
      let subtotalMinor = 0;
      for (const row of linesResult.rows) {
        const unitPriceMinor = minor(row.price_minor);
        if (unitPriceMinor === null || !row.sku?.trim() || row.currency !== cart.currency ||
            !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 99) {
          await client.query("ROLLBACK");
          return { outcome: "invalid_snapshot", reason: unitPriceMinor === null ? "invalid_catalog_price" : "currency_mismatch" };
        }
        const lineTotalMinor = unitPriceMinor * row.quantity;
        if (!Number.isSafeInteger(lineTotalMinor) || !Number.isSafeInteger(subtotalMinor + lineTotalMinor)) {
          await client.query("ROLLBACK");
          return { outcome: "invalid_snapshot", reason: "unsafe_total" };
        }
        const line: RepricedCartLine = {
          cartItemId: row.item_id, merchantId: row.merchant_id, branchId: row.branch_id,
          merchantTenantId: row.merchant_tenant_id, productVariantId: row.product_variant_id,
          title: row.title, sku: row.sku, quantity: row.quantity, unitPriceMinor,
          lineTotalMinor, currency: cart.currency
        };
        items.push(line);
        subtotalMinor += lineTotalMinor;
        const key = JSON.stringify([row.merchant_id, row.branch_id]);
        let group = groups.get(key);
        if (!group) {
          group = { merchantId: row.merchant_id, branchId: row.branch_id,
            merchantTenantId: row.merchant_tenant_id, items: [], subtotalMinor: 0 };
          groups.set(key, group);
        }
        if (!Number.isSafeInteger(group.subtotalMinor + lineTotalMinor)) {
          await client.query("ROLLBACK");
          return { outcome: "invalid_snapshot", reason: "unsafe_total" };
        }
        group.items.push(line);
        group.subtotalMinor += lineTotalMinor;
      }

      await client.query("COMMIT");
      return {
        outcome: "priced", cartId: cart.id, customerId: cart.customer_id,
        cartVersion: cart.version, currency: cart.currency, items,
        suborders: [...groups.values()], subtotalMinor
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Reprices and locks the cart using a caller-owned transaction. The caller owns
   * connection lifecycle and commit/rollback; locks remain held until that completes.
   */
  async repriceInTransaction(input: { customerId: string; expectedCartVersion: number }, client: PostgresClient): Promise<CustomerCartRepricingResult> {
    if (!input.customerId.trim() || !Number.isSafeInteger(input.expectedCartVersion) || input.expectedCartVersion < 1) {
      throw new Error("invalid_customer_cart_repricing_request");
    }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["customer-cart:" + input.customerId]);

      const headerResult = await client.query<CartHeader>(
        "SELECT id, customer_id, currency, version FROM customer_carts WHERE tenant_id=$1 AND customer_id=$2 AND status='active' FOR UPDATE",
        ["platform", input.customerId]
      );
      const cart = headerResult.rows[0];
      if (!cart) {
        return { outcome: "not_found" };
      }
      if (cart.version !== input.expectedCartVersion) {
        return { outcome: "version_conflict" };
      }

      const countResult = await client.query<CartCount>(
        "SELECT COUNT(*)::int AS item_count FROM customer_cart_items WHERE tenant_id=$1 AND cart_id=$2",
        ["platform", cart.id]
      );
      const itemCount = Number(countResult.rows[0]?.item_count ?? 0);
      if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
        return { outcome: "invalid_snapshot", reason: "unsafe_total" };
      }
      if (itemCount === 0) {
        return { outcome: "empty" };
      }

      const linesResult = await client.query<RepricingRow>(
        `SELECT ci.id AS item_id, ci.merchant_id, ci.branch_id,
                ci.merchant_tenant_id, ci.product_variant_id, ci.quantity,
                p.title, v.sku, COALESCE(v.currency,p.currency) AS currency,
                COALESCE(v.price_minor,p.price_minor) AS price_minor,
                (m.status='active') AS merchant_active,
                (b.status='active') AS branch_active,
                (p.published_at IS NOT NULL) AS product_published,
                (i.last_synced_at >= clock_timestamp()-interval '30 minutes'
                  AND i.availability_confidence IN ('high','medium')
                  AND i.available_quantity-i.reserved_quantity >= ci.quantity) AS stock_eligible
         FROM customer_cart_items ci
         JOIN commerce_catalog_variants v
           ON v.tenant_id=ci.merchant_tenant_id AND v.id=ci.product_variant_id
         JOIN commerce_catalog_products p
           ON p.tenant_id=v.tenant_id AND p.id=v.product_id
         JOIN merchants m
           ON m.tenant_id=ci.merchant_tenant_id AND m.id=ci.merchant_id
         JOIN merchant_branches b
           ON b.merchant_id=ci.merchant_id AND b.id=ci.branch_id
         JOIN branch_inventory i
           ON i.merchant_id=ci.merchant_id AND i.branch_id=ci.branch_id
          AND i.product_variant_id=v.external_variant_id AND i.sku=v.sku
         WHERE ci.tenant_id=$1 AND ci.cart_id=$2
         ORDER BY ci.merchant_id,ci.branch_id,ci.product_variant_id
         FOR UPDATE OF ci,v,p,m,b,i`,
        ["platform", cart.id]
      );

      if (linesResult.rows.length !== itemCount) {
        return { outcome: "unavailable", reason: "inventory_or_catalog_mapping_missing" };
      }
      if (linesResult.rows.some(row => !row.merchant_active || !row.branch_active || !row.product_published || !row.stock_eligible)) {
        return { outcome: "unavailable", reason: "inventory_stale_or_insufficient" };
      }

      if (!cart.currency || !/^[A-Z]{3}$/.test(cart.currency)) {
        return { outcome: "invalid_snapshot", reason: "currency_mismatch" };
      }

      const items: RepricedCartLine[] = [];
      const groups = new Map<string, { merchantId: string; branchId: string; merchantTenantId: string; items: RepricedCartLine[]; subtotalMinor: number }>();
      let subtotalMinor = 0;
      for (const row of linesResult.rows) {
        const unitPriceMinor = minor(row.price_minor);
        if (unitPriceMinor === null || !row.sku?.trim() || row.currency !== cart.currency ||
            !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 99) {
            return { outcome: "invalid_snapshot", reason: unitPriceMinor === null ? "invalid_catalog_price" : "currency_mismatch" };
        }
        const lineTotalMinor = unitPriceMinor * row.quantity;
        if (!Number.isSafeInteger(lineTotalMinor) || !Number.isSafeInteger(subtotalMinor + lineTotalMinor)) {
            return { outcome: "invalid_snapshot", reason: "unsafe_total" };
        }
        const line: RepricedCartLine = {
          cartItemId: row.item_id, merchantId: row.merchant_id, branchId: row.branch_id,
          merchantTenantId: row.merchant_tenant_id, productVariantId: row.product_variant_id,
          title: row.title, sku: row.sku, quantity: row.quantity, unitPriceMinor,
          lineTotalMinor, currency: cart.currency
        };
        items.push(line);
        subtotalMinor += lineTotalMinor;
        const key = JSON.stringify([row.merchant_id, row.branch_id]);
        let group = groups.get(key);
        if (!group) {
          group = { merchantId: row.merchant_id, branchId: row.branch_id,
            merchantTenantId: row.merchant_tenant_id, items: [], subtotalMinor: 0 };
          groups.set(key, group);
        }
        if (!Number.isSafeInteger(group.subtotalMinor + lineTotalMinor)) {
            return { outcome: "invalid_snapshot", reason: "unsafe_total" };
        }
        group.items.push(line);
        group.subtotalMinor += lineTotalMinor;
      }
  }

}
