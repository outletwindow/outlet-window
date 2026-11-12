import type { PostgresPool } from "./postgres-iam-store.js";
import type { AuditEvent } from "./audit.js";
import { PostgresAuditEventStore } from "./postgres-audit-event-store.js";
import {
  aggregateParentOrderStatus,
  transitionOrder,
  type OrderStatus,
  type OrderTransitionContext,
  type OrderTransitionResult
} from "./order-lifecycle.js";

export type PersistedOrderTransitionResult =
  | { outcome: "updated"; transition: Extract<OrderTransitionResult, { ok: true }>; parentStatus: OrderStatus }
  | { outcome: "not_found" }
  | { outcome: "conflict" }
  | { outcome: "rejected"; reason: Extract<OrderTransitionResult, { ok: false }>["reason"] | "preparation_checks_incomplete" };

type LockedSuborder = {
  id: string; order_id: string; tenant_id: string; status: OrderStatus;
  version: number; merchant_id: string; branch_id: string;
};
type StatusRow = { status: OrderStatus };

/**
 * Persists a merchant-suborder transition and its derived parent status atomically.
 * Callers must authorize the actor and scope before invoking this repository.
 */
export class PostgresOrderTransitionStore {
  constructor(private readonly pool: PostgresPool) {}

  async transitionSuborder(input: {
    tenantId: string;
    orderId: string;
    suborderId: string;
    nextStatus: OrderStatus;
    context: OrderTransitionContext;
    auditEvent: AuditEvent;
  }): Promise<PersistedOrderTransitionResult> {
    if (input.auditEvent.tenantId !== input.tenantId ||
        input.auditEvent.actor.id !== input.context.actorId ||
        input.auditEvent.resourceId !== input.suborderId ||
        input.auditEvent.action !== "order.suborder.transition" ||
        input.auditEvent.outcome !== "success") {
      throw new Error("Order transition audit event does not match the operation");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<LockedSuborder>(
        `SELECT s.id, s.order_id, s.tenant_id, s.status, s.version,
                s.merchant_id, s.branch_id
         FROM merchant_suborders s
         JOIN customer_orders o ON o.id = s.order_id
         WHERE s.tenant_id = $1 AND s.order_id = $2 AND s.id = $3
         FOR UPDATE OF o, s`,
        [input.tenantId, input.orderId, input.suborderId]
      );
      if (!locked.rowCount) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      const current = locked.rows[0]!;
      if (input.nextStatus === "ready_for_pickup") {
        const preparation = await client.query<{ item_count: number; verified_count: number }>(
          `SELECT COUNT(i.id)::int AS item_count,
                  COUNT(c.order_item_id) FILTER (WHERE c.outcome = 'verified')::int AS verified_count
           FROM customer_order_items i
           LEFT JOIN merchant_order_item_preparation_checks c
             ON c.tenant_id = i.tenant_id AND c.suborder_id = i.suborder_id
             AND c.order_item_id = i.id
           WHERE i.tenant_id = $1 AND i.order_id = $2 AND i.suborder_id = $3
             AND i.merchant_id = $4 AND i.branch_id = $5`,
          [input.tenantId, input.orderId, input.suborderId, current.merchant_id, current.branch_id]
        );
        const counts = preparation.rows[0];
        if (!counts || Number(counts.item_count) === 0 ||
            Number(counts.verified_count) !== Number(counts.item_count)) {
          await client.query("ROLLBACK");
          return { outcome: "rejected", reason: "preparation_checks_incomplete" };
        }
      }
      if (current.version !== input.context.expectedVersion) {
        await client.query("ROLLBACK");
        return { outcome: "conflict" };
      }
      const transition = transitionOrder({
        orderId: current.id,
        status: current.status,
        version: current.version,
        updatedAt: new Date().toISOString(),
        merchantId: current.merchant_id,
        branchId: current.branch_id,
        parentOrderId: current.order_id
      }, input.nextStatus, input.context);
      if (!transition.ok) {
        await client.query("ROLLBACK");
        return { outcome: "rejected", reason: transition.reason };
      }

      const changed = await client.query(
        `UPDATE merchant_suborders
         SET status = $4, version = version + 1, updated_at = $5
         WHERE tenant_id = $1 AND order_id = $2 AND id = $3 AND version = $6`,
        [input.tenantId, input.orderId, input.suborderId, input.nextStatus,
          transition.order.updatedAt, input.context.expectedVersion]
      );
      if (changed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { outcome: "conflict" };
      }

      const statuses = await client.query<StatusRow>(
        "SELECT status FROM merchant_suborders WHERE order_id = $1 ORDER BY id",
        [input.orderId]
      );
      const parentStatus = aggregateParentOrderStatus(statuses.rows.map(row => row.status));
      const parentChanged = await client.query(
        `UPDATE customer_orders
         SET status = $2, version = version + 1, updated_at = $3
         WHERE id = $1`,
        [input.orderId, parentStatus, transition.order.updatedAt]
      );
      if (parentChanged.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { outcome: "conflict" };
      }
      // The audit record shares the business transaction: neither can commit alone.
      await new PostgresAuditEventStore(client).append(input.auditEvent);
      await client.query("COMMIT");
      return { outcome: "updated", transition, parentStatus };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
