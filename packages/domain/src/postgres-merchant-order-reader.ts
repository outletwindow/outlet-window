import type { PostgresQueryable } from "./postgres-iam-store.js";
import type { OrderStatus } from "./order-lifecycle.js";

export interface MerchantOrderSummary {
  orderId: string;
  suborderId: string;
  merchantId: string;
  branchId: string;
  orderStatus: string;
  suborderStatus: OrderStatus;
  subtotalMinor: number;
  currency: string;
  itemCount: number;
  createdAtUtc: string;
  task: null | { id: string; status: string; version: number };
}

/** Read-only merchant/branch scoped order reader. Never returns customer PII or parent-order totals. */
export class PostgresMerchantOrderReader {
  constructor(private readonly database: PostgresQueryable) {}

  async listForBranch(input: {
    tenantId: string;
    merchantId: string;
    branchId: string;
    status?: OrderStatus;
    limit?: number;
  }): Promise<MerchantOrderSummary[]> {
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
    const result = await this.database.query<{
      order_id: string;
      suborder_id: string;
      merchant_id: string;
      branch_id: string;
      order_status: string;
      suborder_status: OrderStatus;
      subtotal_minor: number | string;
      currency: string;
      item_count: number | string;
      created_at: Date | string;
      task_id: string | null;
      task_status: string | null;
      task_version: number | null;
    }>(
      `SELECT o.id AS order_id, s.id AS suborder_id, s.merchant_id, s.branch_id,
              o.status AS order_status, s.status AS suborder_status,
              s.subtotal_minor, o.currency,
              (SELECT COUNT(*)::int FROM customer_order_items i
               WHERE i.tenant_id = s.tenant_id AND i.order_id = s.order_id
                 AND i.suborder_id = s.id) AS item_count,
              s.created_at,
              task.id AS task_id, task.status AS task_status, task.version AS task_version
       FROM merchant_suborders s
       JOIN customer_orders o ON o.id = s.order_id
       LEFT JOIN LATERAL (
         SELECT t.id, t.status, t.version
         FROM courier_delivery_tasks t
         WHERE t.tenant_id = s.tenant_id AND t.suborder_id = s.id
         ORDER BY t.offered_at DESC, t.created_at DESC
         LIMIT 1
       ) task ON TRUE
       WHERE s.tenant_id = $1 AND s.merchant_id = $2 AND s.branch_id = $3
         AND ($4::text IS NULL OR s.status = $4)
       ORDER BY s.created_at DESC, s.id
       LIMIT $5`,
      [input.tenantId, input.merchantId, input.branchId, input.status ?? null, limit]
    );
    return result.rows.map(row => ({
      orderId: row.order_id,
      suborderId: row.suborder_id,
      merchantId: row.merchant_id,
      branchId: row.branch_id,
      orderStatus: row.order_status,
      suborderStatus: row.suborder_status,
      subtotalMinor: Number(row.subtotal_minor),
      currency: row.currency,
      itemCount: Number(row.item_count),
      createdAtUtc: new Date(row.created_at).toISOString(),
      task: row.task_id === null ? null : {
        id: row.task_id,
        status: row.task_status!,
        version: row.task_version!
      }
    }));
  }
}
