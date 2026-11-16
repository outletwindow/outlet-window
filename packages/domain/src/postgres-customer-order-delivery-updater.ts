import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";
import {
  evaluatePaidOrderEditWindow,
  validateDeliveryDestinationChange,
  type DeliveryCoordinate,
  type DeliveryServiceArea,
  type RepricedDeliveryQuote
} from "./order-editing.js";

type LockedOrder = {
  status: "confirmed" | "merchant_acceptance_pending" | "preparing" | "ready_for_pickup" |
    "pickup_in_progress" | "in_transit" | "out_for_delivery" | "delivered" | "completed" |
    "cancelled" | "refunded";
  currency: string;
  total_minor: string | number;
  payment_captured_at: Date | string;
  delivery_destination: Record<string, unknown> | null;
  delivery_quote: Record<string, unknown> | null;
  delivery_zone_id: string | null;
  delivery_branch_id: string | null;
};

export type UpdateDeliveryDestinationResult =
  | { outcome: "updated"; branchChanged: boolean; quote: RepricedDeliveryQuote }
  | { outcome: "not_found" | "edit_window_expired" | "fulfillment_already_started" |
      "outside_service_area" | "invalid_destination" | "invalid_service_area" | "invalid_quote" | "version_conflict" | "payment_adjustment_required" };

function asSnapshot(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/**
 * Transactional persistence for customer destination changes. The caller must authenticate
 * the customer and obtain the service-area definition and quote from trusted server services.
 * Locks the order/payment evidence, rechecks the five-second deadline, and persists price,
 * ETA, zone and selected branch together with an immutable edit event.
 */
export class PostgresCustomerOrderDeliveryUpdater {
  constructor(private readonly pool: PostgresPool, private readonly now: () => Date = () => new Date()) {}

  async update(input: {
    tenantId: string;
    customerId: string;
    orderId: string;
    actorId: string;
    destination: DeliveryCoordinate;
    serviceArea: DeliveryServiceArea;
    quote: RepricedDeliveryQuote;
  }): Promise<UpdateDeliveryDestinationResult> {
    for (const [value, field] of [
      [input.tenantId, "tenant_id"], [input.customerId, "customer_id"],
      [input.orderId, "order_id"], [input.actorId, "actor_id"]
    ] as const) {
      if (!value.trim() || value.length > 200) throw new Error("invalid_" + field);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<LockedOrder>(
        `SELECT o.status, o.currency, o.total_minor, c.payment_captured_at,
                o.delivery_destination, o.delivery_quote, o.delivery_zone_id, o.delivery_branch_id
         FROM customer_orders o
         JOIN scheduled_order_confirmations c
           ON c.tenant_id = o.tenant_id AND c.order_id = o.id
         WHERE o.tenant_id = $1 AND o.customer_id = $2 AND o.id = $3
         FOR UPDATE OF o, c`,
        [input.tenantId, input.customerId, input.orderId]
      );
      if (locked.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      const current = locked.rows[0]!;
      const nowUtc = this.now().toISOString();
      const dispatched = await client.query(
        `SELECT 1 FROM scheduled_task_outbox
         WHERE tenant_id = $1 AND order_id = $2 AND status IN ('leased','published','dead_letter')
         UNION ALL
         SELECT 1 FROM scheduled_task_inbox
         WHERE tenant_id = $1 AND order_id = $2 AND status IN ('processing','completed','dead_letter')
         LIMIT 1`,
        [input.tenantId, input.orderId]
      );
      const window = evaluatePaidOrderEditWindow({
        paymentCapturedAtUtc: new Date(current.payment_captured_at).toISOString(),
        nowUtc,
        status: current.status,
        fulfillmentTaskDispatched: (dispatched.rowCount ?? dispatched.rows.length) > 0
      });
      if (!window.allowed) {
        await client.query("ROLLBACK");
        return {
          outcome: window.reason === "fulfillment_already_started"
            ? "fulfillment_already_started" : "edit_window_expired"
        };
      }
      if (input.quote.currency !== current.currency) {
        await client.query("ROLLBACK");
        return { outcome: "invalid_quote" };
      }
      // Never silently capture an increase or issue a refund for a decrease. Until a payment
      // provider confirms the exact adjustment, fail closed and leave the order unchanged.
      if (!Number.isSafeInteger(input.quote.totalMinor) || BigInt(input.quote.totalMinor) !== BigInt(current.total_minor)) {
        await client.query("ROLLBACK");
        return { outcome: "payment_adjustment_required" };
      }
      const validation = validateDeliveryDestinationChange({
        destination: input.destination,
        serviceArea: input.serviceArea,
        currentBranchId: current.delivery_branch_id ?? "",
        quote: input.quote,
        nowUtc
      });
      if (!validation.allowed) {
        await client.query("ROLLBACK");
        return { outcome: validation.reason };
      }
      const previous = {
        destination: current.delivery_destination,
        quote: current.delivery_quote,
        zoneId: current.delivery_zone_id,
        branchId: current.delivery_branch_id
      };
      const next = {
        destination: validation.destination,
        quote: validation.quote,
        zoneId: input.serviceArea.id,
        branchId: validation.quote.branchId
      };
      const changed = await client.query(
        `UPDATE customer_orders
         SET delivery_destination = $4::jsonb,
             delivery_quote = $5::jsonb,
             delivery_zone_id = $6,
             delivery_branch_id = $7,
             total_minor = $8,
             version = version + 1,
             updated_at = $9
         WHERE tenant_id = $1 AND customer_id = $2 AND id = $3
           AND status IN ('confirmed','merchant_acceptance_pending')
         RETURNING id`,
        [input.tenantId, input.customerId, input.orderId,
          JSON.stringify(next.destination), JSON.stringify(next.quote),
          next.zoneId, next.branchId, next.quote.totalMinor, nowUtc]
      );
      if (changed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { outcome: "version_conflict" };
      }
      await client.query(
        `INSERT INTO customer_order_edit_events
         (id,tenant_id,order_id,actor_id,edit_type,occurred_at,previous_snapshot,next_snapshot,quote_reference)
         VALUES ($1,$2,$3,$4,'delivery_destination',$5,$6::jsonb,$7::jsonb,$8)`,
        [randomUUID(), input.tenantId, input.orderId, input.actorId, nowUtc,
          JSON.stringify(asSnapshot(previous)), JSON.stringify(asSnapshot(next)), next.quote.quoteReference]
      );
      await client.query("COMMIT");
      return { outcome: "updated", branchChanged: validation.changedBranch, quote: validation.quote };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
