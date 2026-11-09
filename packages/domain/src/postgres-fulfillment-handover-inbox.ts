import { createHash, randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";
import type { VerifiedFulfillmentHandoverEvent } from "./fulfillment-handover-provider.js";

export type FulfillmentHandoverApplyResult =
  | { outcome: "applied"; receiptId: string }
  | { outcome: "duplicate"; receiptId: string }
  | { outcome: "event_id_collision" }
  | { outcome: "reservation_not_found" }
  | { outcome: "reservation_already_finalized"; status: string }
  | { outcome: "reservation_expired" };

/**
 * Stores verified carrier events and applies inventory consumption in the same
 * transaction. This adapter accepts only the normalized type returned by the
 * signature verifier; callers must never construct it from an untrusted body.
 */
export class PostgresFulfillmentHandoverInbox {
  constructor(private readonly pool: PostgresPool) {}

  async recordAndApply(input: {
    event: VerifiedFulfillmentHandoverEvent;
    rawBody: string;
    nowUtc?: string;
  }): Promise<FulfillmentHandoverApplyResult> {
    const { event, rawBody } = input;
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(event.providerKey) ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(event.providerEventId) ||
        event.eventType !== "handover.completed" ||
        typeof event.handoverReference !== "string" ||
        !event.handoverReference.startsWith(event.providerKey + ":") ||
        event.handoverReference.length > 240 ||
        typeof event.occurredAtUtc !== "string" ||
        !Number.isFinite(Date.parse(event.occurredAtUtc)) ||
        !rawBody || Buffer.byteLength(rawBody, "utf8") > 65_536) {
      throw new Error("INVALID_FULFILLMENT_HANDOVER_RECEIPT");
    }
    const digest = createHash("sha256").update(rawBody, "utf8").digest("hex");
    const nowUtc = new Date(input.nowUtc ?? new Date().toISOString()).toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO fulfillment_handover_events
         (id,provider_key,provider_event_id,payload_sha256,tenant_id,merchant_id,
          branch_id,reservation_id,handover_reference,occurred_at,status,received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'received',$11)
         ON CONFLICT (provider_key,provider_event_id) DO NOTHING RETURNING id`,
        [randomUUID(), event.providerKey, event.providerEventId, digest, event.tenantId,
          event.merchantId, event.branchId, event.reservationId, event.handoverReference,
          event.occurredAtUtc, nowUtc]
      );
      if (inserted.rowCount !== 1) {
        const prior = await client.query<{ id: string; payload_sha256: string }>(
          "SELECT id,payload_sha256 FROM fulfillment_handover_events WHERE provider_key=$1 AND provider_event_id=$2 FOR UPDATE",
          [event.providerKey, event.providerEventId]
        );
        if (prior.rowCount !== 1) throw new Error("FULFILLMENT_HANDOVER_RECEIPT_LOOKUP_FAILED");
        await client.query("COMMIT");
        return prior.rows[0]!.payload_sha256 === digest
          ? { outcome: "duplicate", receiptId: prior.rows[0]!.id }
          : { outcome: "event_id_collision" };
      }
      const receiptId = inserted.rows[0]!.id;
      const reservation = await client.query<{
        id: string; status: string; expires_at: Date | string | null;
      }>(
        `SELECT id,status,expires_at FROM inventory_reservations
         WHERE tenant_id=$1 AND merchant_id=$2 AND branch_id=$3 AND id=$4 FOR UPDATE`,
        [event.tenantId,event.merchantId,event.branchId,event.reservationId]
      );
      if (reservation.rowCount !== 1) {
        await client.query("UPDATE fulfillment_handover_events SET status='rejected',processed_at=$2,failure_code='RESERVATION_NOT_FOUND' WHERE id=$1",
          [receiptId,nowUtc]);
        await client.query("COMMIT");
        return { outcome: "reservation_not_found" };
      }
      const current = reservation.rows[0]!;
      if (current.status !== "reserved") {
        await client.query("UPDATE fulfillment_handover_events SET status='rejected',processed_at=$2,failure_code='RESERVATION_ALREADY_FINALIZED' WHERE id=$1",
          [receiptId,nowUtc]);
        await client.query("COMMIT");
        return { outcome: "reservation_already_finalized", status: current.status };
      }
      if (current.expires_at !== null && new Date(current.expires_at).getTime() <= Date.parse(nowUtc)) {
        await client.query("UPDATE fulfillment_handover_events SET status='rejected',processed_at=$2,failure_code='RESERVATION_EXPIRED' WHERE id=$1",
          [receiptId,nowUtc]);
        await client.query("COMMIT");
        return { outcome: "reservation_expired" };
      }
      const lines = await client.query<{
        merchant_id: string; branch_id: string; product_variant_id: string; quantity: number;
      }>(
        `SELECT merchant_id,branch_id,product_variant_id,quantity
         FROM inventory_reservation_lines WHERE reservation_id=$1
           AND merchant_id=$2 AND branch_id=$3
         ORDER BY merchant_id,branch_id,product_variant_id`,
        [event.reservationId,event.merchantId,event.branchId]
      );
      if (!lines.rowCount) throw new Error("inventory_reservation_lines_missing");
      const stock = await client.query<{
        product_variant_id: string; available_quantity: number; reserved_quantity: number;
      }>(
        `SELECT i.product_variant_id,i.available_quantity,i.reserved_quantity
         FROM branch_inventory i JOIN inventory_reservation_lines l
           ON l.merchant_id=i.merchant_id AND l.branch_id=i.branch_id
          AND l.product_variant_id=i.product_variant_id
         WHERE l.reservation_id=$1 AND l.merchant_id=$2 AND l.branch_id=$3
         ORDER BY i.merchant_id,i.branch_id,i.product_variant_id FOR UPDATE OF i`,
        [event.reservationId,event.merchantId,event.branchId]
      );
      if (stock.rowCount !== lines.rowCount) throw new Error("inventory_reservation_stock_missing");
      const byVariant = new Map(stock.rows.map(row => [row.product_variant_id,row]));
      for (const line of lines.rows) {
        const row = byVariant.get(line.product_variant_id);
        if (!row || row.reserved_quantity < line.quantity || row.available_quantity < line.quantity) {
          throw new Error("inventory_reservation_stock_ledger_conflict");
        }
      }
      for (const line of lines.rows) {
        const changed = await client.query(
          `UPDATE branch_inventory SET reserved_quantity=reserved_quantity-$4,
             available_quantity=available_quantity-$4,updated_at=$5
           WHERE merchant_id=$1 AND branch_id=$2 AND product_variant_id=$3
             AND reserved_quantity >= $4 AND available_quantity >= $4`,
          [line.merchant_id,line.branch_id,line.product_variant_id,line.quantity,nowUtc]
        );
        if (changed.rowCount !== 1) throw new Error("inventory_reservation_stock_ledger_conflict");
      }
      const finalized = await client.query(
        `UPDATE inventory_reservations SET status='consumed',updated_at=$5,
           finalization_reason=NULL,handover_reference=$6
         WHERE tenant_id=$1 AND merchant_id=$2 AND branch_id=$3 AND id=$4 AND status='reserved'`,
        [event.tenantId,event.merchantId,event.branchId,event.reservationId,nowUtc,event.handoverReference]
      );
      if (finalized.rowCount !== 1) throw new Error("inventory_reservation_finalize_conflict");
      const applied = await client.query(
        "UPDATE fulfillment_handover_events SET status='applied',processed_at=$2,failure_code=NULL WHERE id=$1 AND status='received'",
        [receiptId,nowUtc]
      );
      if (applied.rowCount !== 1) throw new Error("FULFILLMENT_HANDOVER_EVENT_STATE_CONFLICT");
      await client.query("COMMIT");
      return { outcome: "applied", receiptId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
