import type { PostgresPool } from "./postgres-iam-store.js";
import type { OrderStatus } from "./order-lifecycle.js";

export interface CreateOrderItemInput {
  id: string;
  productVariantId: string;
  sku: string;
  sizeLabel?: string;
  colorLabel?: string;
  quantity: number;
  unitPriceMinor: number;
  currency: string;
}
export interface CreateOrderSuborderInput {
  id: string;
  merchantId: string;
  branchId: string;
  status: OrderStatus;
  subtotalMinor: number;
  items: readonly CreateOrderItemInput[];
  metadata?: Readonly<Record<string, unknown>>;
}
export interface CreateCustomerOrderInput {
  id: string;
  tenantId: string;
  customerId: string;
  idempotencyKey: string;
  currency: string;
  totalMinor: number;
  metadata?: Readonly<Record<string, unknown>>;
  suborders: readonly CreateOrderSuborderInput[];
}
export type CreateCustomerOrderResult =
  | { outcome: "created"; orderId: string }
  | { outcome: "already_exists"; orderId: string }
  | { outcome: "idempotency_conflict"; orderId: string };

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Metadata must contain JSON values");
    return encoded;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Metadata numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("Metadata must contain JSON values");
  if (ancestors.has(value)) throw new Error("Metadata cannot contain circular references");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return "[" + Array.from(value, item => canonicalJson(item, ancestors)).join(",") + "]";
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Metadata cannot contain symbol keys");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Metadata must contain plain JSON objects");
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map(key =>
      JSON.stringify(key) + ":" + canonicalJson(record[key], ancestors)
    ).join(",") + "}";
  } finally { ancestors.delete(value); }
}

function validateMetadata(value: Readonly<Record<string, unknown>> | undefined, field: string): string {
  const metadata = value ?? {};
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    throw new Error(field + " must be a JSON object");
  }
  return canonicalJson(metadata);
}

function requireIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}

function sortedItems<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

export class PostgresOrderStore {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateCustomerOrderInput): Promise<CreateCustomerOrderResult> {
    requireIdentifier(input.id, "Order ID");
    requireIdentifier(input.tenantId, "Tenant ID");
    requireIdentifier(input.customerId, "Customer ID");
    requireIdentifier(input.idempotencyKey, "Idempotency key");
    if (input.idempotencyKey.trim().length < 8 || input.idempotencyKey.trim().length > 200) throw new Error("Idempotency key must contain 8 to 200 characters");
    const canonicalOrderMetadata = validateMetadata(input.metadata, "Order metadata");
    if (!Array.isArray(input.suborders) || !input.suborders.length) {
      throw new Error("An order requires at least one merchant suborder");
    }
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error("Currency must be an ISO 4217 code");
    if (!Number.isSafeInteger(input.totalMinor) || input.totalMinor < 0) throw new Error("Invalid order total");
    const suborderIds = new Set<string>();
    const itemIds = new Set<string>();
    for (const suborder of input.suborders) {
      requireIdentifier(suborder.id, "Suborder ID");
      requireIdentifier(suborder.merchantId, "Merchant ID");
      requireIdentifier(suborder.branchId, "Branch ID");
      validateMetadata(suborder.metadata, "Suborder metadata");
      if (suborderIds.has(suborder.id)) throw new Error("Duplicate suborder ID");
      suborderIds.add(suborder.id);
      if (!Number.isSafeInteger(suborder.subtotalMinor) || suborder.subtotalMinor < 0) {
        throw new Error("Invalid suborder subtotal");
      }
      if (!Array.isArray(suborder.items) || suborder.items.length === 0) {
        throw new Error("A merchant suborder requires at least one order item");
      }
      let itemsSubtotal = 0;
      const suborderVariantIds = new Set<string>();
      for (const item of suborder.items) {
        requireIdentifier(item.id, "Order item ID");
        requireIdentifier(item.productVariantId, "Product variant ID");
        requireIdentifier(item.sku, "SKU");
        if (item.productVariantId.length > 200 || item.sku.length > 120) throw new Error("Invalid order item identifier length");
        if (itemIds.has(item.id)) throw new Error("Duplicate order item ID");
        itemIds.add(item.id);
        if (suborderVariantIds.has(item.productVariantId)) {
          throw new Error("A merchant suborder cannot contain duplicate product variants");
        }
        suborderVariantIds.add(item.productVariantId);
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 ||
            !Number.isSafeInteger(item.unitPriceMinor) || item.unitPriceMinor < 0 ||
            item.currency !== input.currency || !/^[A-Z]{3}$/.test(item.currency)) {
          throw new Error("Invalid order item price, quantity, or currency");
        }
        for (const [value, field] of [[item.sizeLabel, "Size label"], [item.colorLabel, "Color label"]] as const) {
          if (value !== undefined && typeof value !== "string") throw new Error(`${field} must be text`);
        }
        const lineTotal = item.quantity * item.unitPriceMinor;
        if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(itemsSubtotal + lineTotal)) {
          throw new Error("Order item subtotal overflow");
        }
        itemsSubtotal += lineTotal;
      }
      if (itemsSubtotal !== suborder.subtotalMinor) {
        throw new Error("Order item totals must equal the merchant suborder subtotal");
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [input.tenantId + ":" + input.customerId + ":" + input.idempotencyKey]
      );
      const existing = await client.query<{
        id: string; currency: string; total_minor: string | number; metadata: Record<string, unknown>;
      }>(
        `SELECT id, currency, total_minor, metadata FROM customer_orders
         WHERE tenant_id = $1 AND customer_id = $2 AND idempotency_key = $3 FOR UPDATE`,
        [input.tenantId, input.customerId, input.idempotencyKey]
      );
      if (existing.rowCount) {
        const row = existing.rows[0]!;
        const persistedSuborders = await client.query<{
          id: string; merchant_id: string; branch_id: string; status: OrderStatus;
          subtotal_minor: string | number; metadata: Record<string, unknown>;
        }>(
          `SELECT id, merchant_id, branch_id, status, subtotal_minor, metadata
           FROM merchant_suborders WHERE order_id = $1 ORDER BY id`,
          [row.id]
        );
        const persistedItems = await client.query<{
          id: string; suborder_id: string; product_variant_id: string; sku: string;
          size_label: string | null; color_label: string | null; quantity: number;
          unit_price_minor: string | number; currency: string;
        }>(
          `SELECT id, suborder_id, product_variant_id, sku, size_label, color_label,
                  quantity, unit_price_minor, currency
           FROM customer_order_items WHERE order_id = $1 ORDER BY suborder_id, id`,
          [row.id]
        );
        const requestedSuborders = [...input.suborders].sort((a, b) => a.id.localeCompare(b.id));
        const sameSuborders = persistedSuborders.rows.length === requestedSuborders.length &&
          persistedSuborders.rows.every((stored, index) => {
            const requested = requestedSuborders[index]!;
            return stored.id === requested.id &&
              stored.merchant_id === requested.merchantId &&
              stored.branch_id === requested.branchId &&
              stored.status === requested.status &&
              String(stored.subtotal_minor) === String(requested.subtotalMinor) &&
              canonicalJson(stored.metadata ?? {}) === canonicalJson(requested.metadata ?? {});
          });
        const requestedItems = input.suborders.flatMap(suborder =>
          suborder.items.map((item: CreateOrderItemInput) => ({ ...item, suborderId: suborder.id }))
        ).sort((a, b) => a.suborderId.localeCompare(b.suborderId) || a.id.localeCompare(b.id));
        const sameItems = persistedItems.rows.length === requestedItems.length &&
          persistedItems.rows.every((stored, index) => {
            const requested = requestedItems[index]!;
            return stored.id === requested.id &&
              stored.suborder_id === requested.suborderId &&
              stored.product_variant_id === requested.productVariantId &&
              stored.sku === requested.sku &&
              stored.size_label === (requested.sizeLabel ?? null) &&
              stored.color_label === (requested.colorLabel ?? null) &&
              stored.quantity === requested.quantity &&
              String(stored.unit_price_minor) === String(requested.unitPriceMinor) &&
              stored.currency === requested.currency;
          });
        const same = row.currency === input.currency &&
          String(row.total_minor) === String(input.totalMinor) &&
          canonicalJson(row.metadata ?? {}) === canonicalOrderMetadata &&
          sameSuborders && sameItems;
        await client.query("COMMIT");
        return same
          ? { outcome: "already_exists", orderId: row.id }
          : { outcome: "idempotency_conflict", orderId: row.id };
      }

      await client.query(
        `INSERT INTO customer_orders
         (id, tenant_id, customer_id, idempotency_key, status, currency, total_minor, metadata)
         VALUES ($1,$2,$3,$4,'pending_validation',$5,$6,$7::jsonb)`,
        [input.id, input.tenantId, input.customerId, input.idempotencyKey,
          input.currency, input.totalMinor, JSON.stringify(input.metadata ?? {})]
      );
      for (const suborder of input.suborders) {
        const inserted = await client.query<{ id: string; tenant_id: string }>(
          `INSERT INTO merchant_suborders
           (id, tenant_id, order_id, merchant_id, branch_id, status, subtotal_minor, metadata)
           SELECT $1, m.tenant_id, $2, m.id, b.id, $5, $6, $7::jsonb
           FROM merchants m
           JOIN merchant_branches b ON b.merchant_id = m.id
           WHERE m.id = $3 AND b.id = $4 AND m.status = 'active' AND b.status = 'active'
           RETURNING id, tenant_id`,
          [suborder.id, input.id, suborder.merchantId, suborder.branchId,
            suborder.status, suborder.subtotalMinor, JSON.stringify(suborder.metadata ?? {})]
        );
        const persistedSuborder = inserted.rows[0];
        if (inserted.rowCount !== 1 || !persistedSuborder) {
          throw new Error("Merchant branch is unavailable for order creation");
        }
        for (const item of suborder.items) {
          await client.query(
            `INSERT INTO customer_order_items
             (id, tenant_id, order_id, suborder_id, merchant_id, branch_id,
              product_variant_id, sku, size_label, color_label, quantity, unit_price_minor, currency)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [item.id, persistedSuborder.tenant_id, input.id, suborder.id,
              suborder.merchantId, suborder.branchId, item.productVariantId, item.sku,
              item.sizeLabel ?? null, item.colorLabel ?? null, item.quantity,
              item.unitPriceMinor, item.currency]
          );
        }
      }
      await client.query("COMMIT");
      return { outcome: "created", orderId: input.id };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
