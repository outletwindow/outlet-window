import type { PostgresPool } from "./postgres-iam-store.js";
import type { OrderStatus } from "./order-lifecycle.js";

export interface CreateOrderSuborderInput {
  id: string;
  merchantId: string;
  branchId: string;
  status: OrderStatus;
  subtotalMinor: number;
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

export class PostgresOrderStore {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateCustomerOrderInput): Promise<CreateCustomerOrderResult> {
    if (!input.suborders.length) throw new Error("An order requires at least one merchant suborder");
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error("Currency must be an ISO 4217 code");
    if (!Number.isSafeInteger(input.totalMinor) || input.totalMinor < 0) throw new Error("Invalid order total");
    const ids = new Set<string>();
    for (const item of input.suborders) {
      if (ids.has(item.id)) throw new Error("Duplicate suborder ID");
      ids.add(item.id);
      if (!Number.isSafeInteger(item.subtotalMinor) || item.subtotalMinor < 0) throw new Error("Invalid suborder subtotal");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ id: string; currency: string; total_minor: string | number; metadata: Record<string, unknown> }>(
        `SELECT id, currency, total_minor, metadata FROM customer_orders
         WHERE tenant_id = $1 AND customer_id = $2 AND idempotency_key = $3 FOR UPDATE`,
        [input.tenantId, input.customerId, input.idempotencyKey]
      );
      if (existing.rowCount) {
        const row = existing.rows[0]!;
        const same = row.currency === input.currency &&
          Number(row.total_minor) === input.totalMinor &&
          JSON.stringify(row.metadata) === JSON.stringify(input.metadata ?? {});
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
      for (const item of input.suborders) {
        await client.query(
          `INSERT INTO merchant_suborders
           (id, tenant_id, order_id, merchant_id, branch_id, status, subtotal_minor, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [item.id, input.tenantId, input.id, item.merchantId, item.branchId,
            item.status, item.subtotalMinor, JSON.stringify(item.metadata ?? {})]
        );
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
