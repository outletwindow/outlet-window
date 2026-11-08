import { randomUUID } from "node:crypto";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";

export type PaymentWebhookReceipt =
  | { outcome: "received"; receiptId: string }
  | { outcome: "duplicate"; receiptId: string }
  | { outcome: "event_id_collision" };

export type PaymentWebhookTerminalStatus = "applied" | "ignored" | "failed";

/**
 * Durable provider-event inbox. Signature verification must happen before record().
 * This class stores only a digest and provider identifiers, never raw webhook payloads.
 */
export class PostgresPaymentWebhookInbox {
  constructor(private readonly pool: PostgresPool) {}

  async record(input: {
    providerKey: string;
    providerEventId: string;
    rawBody: string;
    adjustmentId?: string;
    eventType?: string;
    normalizedStatus?: "succeeded" | "failed" | "ignored" | "unsupported";
    providerReference?: string;
  }): Promise<PaymentWebhookReceipt> {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey) ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(input.providerEventId) ||
        typeof input.rawBody !== "string" || input.rawBody.length === 0 ||
        Buffer.byteLength(input.rawBody, "utf8") > 65_536 ||
        (input.adjustmentId !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(input.adjustmentId)) ||
        (input.eventType !== undefined && !/^[a-zA-Z0-9._:-]{1,160}$/.test(input.eventType)) ||
        (input.normalizedStatus !== undefined && !["succeeded", "failed", "ignored", "unsupported"].includes(input.normalizedStatus)) ||
        (input.providerReference !== undefined && (!input.providerReference.trim() || input.providerReference.length > 240))) {
      throw new Error("INVALID_PAYMENT_WEBHOOK_RECEIPT");
    }
    const digest = createSha256(input.rawBody);
    const id = randomUUID();
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO payment_provider_webhook_events
       (id, provider_key, provider_event_id, payload_sha256, status, adjustment_id,
        event_type, normalized_status, provider_reference)
       VALUES ($1,$2,$3,$4,'received',$5,$6,$7,$8)
       ON CONFLICT (provider_key, provider_event_id) DO NOTHING
       RETURNING id`,
      [id, input.providerKey, input.providerEventId, digest, input.adjustmentId ?? null,
        input.eventType ?? null, input.normalizedStatus ?? null, input.providerReference ?? null]
    );
    if (inserted.rowCount === 1) return { outcome: "received", receiptId: inserted.rows[0]!.id };
    const existing = await this.pool.query<{ id: string; payload_sha256: string }>(
      "SELECT id,payload_sha256 FROM payment_provider_webhook_events WHERE provider_key=$1 AND provider_event_id=$2",
      [input.providerKey, input.providerEventId]
    );
    if (existing.rowCount !== 1) throw new Error("PAYMENT_WEBHOOK_RECEIPT_LOOKUP_FAILED");
    if (existing.rows[0]!.payload_sha256 !== digest) return { outcome: "event_id_collision" };
    return { outcome: "duplicate", receiptId: existing.rows[0]!.id };
  }

  /**
   * Applies a normalized provider result and finalizes its inbox receipt in one DB transaction.
   * Call only after signature verification, durable receipt creation, and provider-specific
   * event normalization. The caller must pass the authenticated service actor identity.
   */
  async reconcileAdjustment(input: {
    receiptId: string;
    adjustmentId: string;
    actorId: string;
    confirmed: boolean;
    providerReference?: string;
    failureCode?: string;
  }): Promise<"applied" | "failed" | "not_processing" | "conflict"> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.receiptId) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(input.adjustmentId) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(input.actorId) ||
        (input.confirmed && (!input.providerReference?.trim() || input.providerReference.length > 240)) ||
        (!input.confirmed && input.failureCode !== undefined && !/^[A-Z0-9_]{1,100}$/.test(input.failureCode))) {
      throw new Error("INVALID_PAYMENT_WEBHOOK_RECONCILIATION");
    }
    const client = await this.pool.connect();
    const now = new Date().toISOString();
    try {
      await client.query("BEGIN");
      const receipt = await client.query<{ id: string; adjustment_id: string | null; status: string }>(
        "SELECT id,adjustment_id,status FROM payment_provider_webhook_events WHERE id=$1 FOR UPDATE",
        [input.receiptId]
      );
      if (receipt.rowCount !== 1 || receipt.rows[0]!.status !== "processing") {
        await client.query("ROLLBACK");
        return "not_processing";
      }
      if (receipt.rows[0]!.adjustment_id !== input.adjustmentId) {
        await client.query("ROLLBACK");
        return "conflict";
      }
      const found = await client.query<{
        id: string; tenant_id: string; order_id: string; customer_id: string;
        currency: string; previous_total_minor: string; proposed_total_minor: string;
        status: string;
      }>(
        "SELECT id,tenant_id,order_id,customer_id,currency,previous_total_minor,proposed_total_minor,status FROM customer_payment_adjustments WHERE id=$1 FOR UPDATE",
        [input.adjustmentId]
      );
      if (found.rowCount !== 1 || found.rows[0]!.status !== "provider_pending") {
        await client.query("ROLLBACK");
        return "conflict";
      }
      const adjustment = found.rows[0]!;
      if (input.confirmed) {
        const order = await client.query(
          "UPDATE customer_orders SET total_minor=$4,version=version+1,updated_at=$5 WHERE tenant_id=$1 AND id=$2 AND customer_id=$3 AND total_minor=$6 AND currency=$7",
          [adjustment.tenant_id, adjustment.order_id, adjustment.customer_id,
            adjustment.proposed_total_minor, now, adjustment.previous_total_minor, adjustment.currency]
        );
        if (order.rowCount !== 1) {
          await client.query("ROLLBACK");
          return "conflict";
        }
        await client.query(
          "UPDATE customer_payment_adjustments SET status='provider_confirmed',provider_reference=$3,provider_confirmed_at=$4,updated_at=$4 WHERE tenant_id=$1 AND id=$2",
          [adjustment.tenant_id, adjustment.id, input.providerReference, now]
        );
        await appendAdjustmentEvent(client, adjustment, input.actorId, "provider_confirmed", now);
        await client.query(
          "UPDATE payment_provider_webhook_events SET status='applied',processed_at=$2,failure_code=NULL WHERE id=$1 AND status='processing'",
          [input.receiptId, now]
        );
        await client.query("COMMIT");
        return "applied";
      }
      await client.query(
        "UPDATE customer_payment_adjustments SET status='provider_failed',updated_at=$3 WHERE tenant_id=$1 AND id=$2",
        [adjustment.tenant_id, adjustment.id, now]
      );
      await appendAdjustmentEvent(client, adjustment, input.actorId, "provider_failed", now);
      await client.query(
        "UPDATE payment_provider_webhook_events SET status='failed',processed_at=$2,failure_code=$3 WHERE id=$1 AND status='processing'",
        [input.receiptId, now, input.failureCode ?? "PROVIDER_PAYMENT_FAILED"]
      );
      await client.query("COMMIT");
      return "failed";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claim(receiptId: string): Promise<"claimed" | "not_pending"> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(receiptId)) throw new Error("INVALID_PAYMENT_WEBHOOK_RECEIPT_ID");
    const result = await this.pool.query<{ id: string }>(
      `UPDATE payment_provider_webhook_events
       SET status='processing'
       WHERE id=$1 AND status='received'
       RETURNING id`,
      [receiptId]
    );
    return result.rowCount === 1 ? "claimed" : "not_pending";
  }

  async finalize(input: {
    receiptId: string;
    status: PaymentWebhookTerminalStatus;
    adjustmentId?: string;
    failureCode?: string;
  }): Promise<"finalized" | "not_processing"> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.receiptId) ||
        !["applied", "ignored", "failed"].includes(input.status) ||
        (input.failureCode !== undefined && !/^[A-Z0-9_]{1,100}$/.test(input.failureCode))) {
      throw new Error("INVALID_PAYMENT_WEBHOOK_FINALIZATION");
    }
    const result = await this.pool.query<{ id: string }>(
      `UPDATE payment_provider_webhook_events
       SET status=$2, processed_at=now(),
           adjustment_id=COALESCE($3, adjustment_id), failure_code=$4
       WHERE id=$1 AND status='processing'
       RETURNING id`,
      [input.receiptId, input.status, input.adjustmentId ?? null, input.failureCode ?? null]
    );
    return result.rowCount === 1 ? "finalized" : "not_processing";
  }
}

function createSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

import { createHash } from "node:crypto";

type AdjustmentEventSnapshot = {
  id: string; tenant_id: string;
};
async function appendAdjustmentEvent(
  client: PostgresClient,
  adjustment: AdjustmentEventSnapshot,
  actorId: string,
  eventType: "provider_confirmed" | "provider_failed",
  occurredAt: string
): Promise<void> {
  await client.query(
    "INSERT INTO customer_payment_adjustment_events (id,tenant_id,adjustment_id,actor_id,event_type,occurred_at,snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
    [randomUUID(), adjustment.tenant_id, adjustment.id, actorId, eventType, occurredAt,
      JSON.stringify({ status: eventType })]
  );
}
