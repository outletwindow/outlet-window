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
   * Atomically deduplicates and reconciles a Moyasar cumulative refund snapshot.
   * The provider event has no local adjustment id; it is correlated through the
   * verified original capture and the single in-flight reservation.
   */
  async recordAndReconcileMoyasarRefund(input: {
    providerEventId: string;
    rawBody: string;
    providerPaymentReference: string;
    refundedMinor: number;
    refundableBaseMinor: number;
    currency: string;
    refundedAtUtc: string;
  }): Promise<"applied" | "ignored" | "reconciliation_required" | "duplicate" | "event_id_collision"> {
    if (!/^[a-zA-Z0-9._:-]{1,240}$/.test(input.providerEventId) ||
        typeof input.rawBody !== "string" || !input.rawBody ||
        Buffer.byteLength(input.rawBody, "utf8") > 65_536 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.providerPaymentReference) ||
        !Number.isSafeInteger(input.refundedMinor) || input.refundedMinor <= 0 ||
        !Number.isSafeInteger(input.refundableBaseMinor) || input.refundableBaseMinor <= 0 ||
        input.refundedMinor > input.refundableBaseMinor ||
        !/^[A-Z]{3}$/.test(input.currency) ||
        !Number.isFinite(Date.parse(input.refundedAtUtc))) {
      throw new Error("INVALID_MOYASAR_REFUND_RECONCILIATION");
    }

    const client = await this.pool.connect();
    const digest = createSha256(input.rawBody);
    const receiptId = randomUUID();
    const now = new Date().toISOString();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO payment_provider_webhook_events
         (id,provider_key,provider_event_id,payload_sha256,status,event_type,provider_reference)
         VALUES ($1,'moyasar',$2,$3,'received','payment_refunded',$4)
         ON CONFLICT (provider_key,provider_event_id) DO NOTHING
         RETURNING id`,
        [receiptId,input.providerEventId,digest,input.providerPaymentReference]
      );
      if (inserted.rowCount !== 1) {
        const existing = await client.query<{ id: string; payload_sha256: string }>(
          "SELECT id,payload_sha256 FROM payment_provider_webhook_events WHERE provider_key='moyasar' AND provider_event_id=$1",
          [input.providerEventId]
        );
        await client.query("COMMIT");
        if (existing.rowCount !== 1) throw new Error("MOYASAR_REFUND_RECEIPT_LOOKUP_FAILED");
        return existing.rows[0]!.payload_sha256 === digest ? "duplicate" : "event_id_collision";
      }

      const capture = await client.query<{
        tenant_id: string; order_id: string; amount_minor: string; currency: string;
      }>(
        `SELECT tenant_id,order_id,amount_minor,currency
         FROM verified_order_payment_captures
         WHERE provider_key='moyasar' AND provider_payment_reference=$1`,
        [input.providerPaymentReference]
      );
      if (capture.rowCount !== 1) {
        await this.quarantineRefundReceipt(client,receiptId,"ORIGINAL_PAYMENT_CAPTURE_NOT_FOUND");
        await client.query("COMMIT");
        return "reconciliation_required";
      }
      const original = capture.rows[0]!;
      const candidate = await client.query<{ adjustment_id: string }>(
        `SELECT r.adjustment_id
         FROM payment_refund_reservations r
         WHERE r.tenant_id=$1 AND r.provider_key='moyasar'
           AND r.original_payment_reference=$2 AND r.status='reserved'
         LIMIT 2`,
        [original.tenant_id,input.providerPaymentReference]
      );
      if (candidate.rows.length > 1) {
        await this.quarantineRefundReceipt(client,receiptId,"MULTIPLE_ACTIVE_REFUND_RESERVATIONS");
        await client.query("COMMIT");
        return "reconciliation_required";
      }
      if (candidate.rows.length === 1) {
        const lockedAdjustment = await client.query(
          "SELECT id FROM customer_payment_adjustments WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [original.tenant_id,candidate.rows[0]!.adjustment_id]
        );
        if (lockedAdjustment.rowCount !== 1) {
          await this.quarantineRefundReceipt(client,receiptId,"REFUND_ADJUSTMENT_NOT_FOUND");
          await client.query("COMMIT");
          return "reconciliation_required";
        }
      }
      const lockedCapture = await client.query<{
        tenant_id: string; order_id: string; amount_minor: string; currency: string;
      }>(
        `SELECT tenant_id,order_id,amount_minor,currency
         FROM verified_order_payment_captures
         WHERE provider_key='moyasar' AND provider_payment_reference=$1
         FOR UPDATE`,
        [input.providerPaymentReference]
      );
      if (lockedCapture.rowCount !== 1 ||
          lockedCapture.rows[0]!.tenant_id !== original.tenant_id ||
          lockedCapture.rows[0]!.order_id !== original.order_id) {
        await this.quarantineRefundReceipt(client,receiptId,"ORIGINAL_PAYMENT_CAPTURE_CHANGED");
        await client.query("COMMIT");
        return "reconciliation_required";
      }
      const originalCaptureMinor = Number(original.amount_minor);
      if (!Number.isSafeInteger(originalCaptureMinor) || originalCaptureMinor <= 0 ||
          original.currency !== input.currency ||
          originalCaptureMinor !== input.refundableBaseMinor ||
          input.refundedMinor > originalCaptureMinor) {
        await this.quarantineRefundReceipt(client,receiptId,"REFUND_CAPTURE_SNAPSHOT_MISMATCH");
        await client.query("COMMIT");
        return "reconciliation_required";
      }

      const active = await client.query<{
        id: string; adjustment_id: string; amount_minor: string; status: string;
        provider_key: string | null; adjustment_status: string;
        submission_status: string;
        currency: string; previous_total_minor: string; proposed_total_minor: string;
        order_id: string; customer_id: string;
      }>(
        `SELECT r.id,r.adjustment_id,r.amount_minor,r.status,
                a.provider_key,a.status AS adjustment_status,o.status AS submission_status,
                a.currency,a.previous_total_minor,a.proposed_total_minor,a.order_id,a.customer_id
         FROM payment_refund_reservations r
         JOIN customer_payment_adjustments a
           ON a.tenant_id=r.tenant_id AND a.id=r.adjustment_id
         JOIN payment_adjustment_submission_outbox o
           ON o.tenant_id=r.tenant_id AND o.adjustment_id=r.adjustment_id
         WHERE r.tenant_id=$1 AND r.provider_key='moyasar'
           AND r.original_payment_reference=$2 AND r.status='reserved'
         FOR UPDATE OF r,a,o`,
        [original.tenant_id,input.providerPaymentReference]
      );
      const consumed = await client.query<{ total_minor: string }>(
        `SELECT COALESCE(SUM(amount_minor),0)::text AS total_minor
         FROM payment_refund_reservations
         WHERE tenant_id=$1 AND provider_key='moyasar'
           AND original_payment_reference=$2 AND status='confirmed'`,
        [original.tenant_id,input.providerPaymentReference]
      );
      const confirmedMinor = Number(consumed.rows[0]?.total_minor ?? "0");
      if (!Number.isSafeInteger(confirmedMinor) || confirmedMinor < 0) {
        await this.quarantineRefundReceipt(client,receiptId,"CONFIRMED_REFUND_TOTAL_INVALID");
        await client.query("COMMIT");
        return "reconciliation_required";
      }

      if (active.rowCount === 0) {
        if (input.refundedMinor === confirmedMinor && confirmedMinor > 0) {
          await client.query(
            "UPDATE payment_provider_webhook_events SET status='ignored',processed_at=$2,failure_code=NULL WHERE id=$1",
            [receiptId,now]
          );
          await client.query("COMMIT");
          return "ignored";
        }
        await this.quarantineRefundReceipt(client,receiptId,"NO_ACTIVE_REFUND_RESERVATION_MATCH");
        await client.query("COMMIT");
        return "reconciliation_required";
      }
      if (active.rowCount !== 1) {
        await this.quarantineRefundReceipt(client,receiptId,"MULTIPLE_ACTIVE_REFUND_RESERVATIONS");
        await client.query("COMMIT");
        return "reconciliation_required";
      }

      const refund = active.rows[0]!;
      const expectedCumulative = confirmedMinor + Number(refund.amount_minor);
      if (refund.status !== "reserved" || refund.adjustment_status !== "provider_pending" ||
          refund.provider_key !== "moyasar" ||
          !["processing","submitted"].includes(refund.submission_status) ||
          refund.currency !== input.currency || refund.order_id !== original.order_id ||
          !Number.isSafeInteger(expectedCumulative) ||
          input.refundedMinor !== expectedCumulative ||
          expectedCumulative > input.refundableBaseMinor) {
        await client.query(
          "UPDATE payment_provider_webhook_events SET adjustment_id=$2 WHERE id=$1",
          [receiptId,refund.adjustment_id]
        );
        await this.quarantineRefundReceipt(client,receiptId,"REFUND_CUMULATIVE_TOTAL_OR_BINDING_MISMATCH");
        await client.query("COMMIT");
        return "reconciliation_required";
      }

      const order = await client.query(
        `UPDATE customer_orders SET total_minor=$4,version=version+1,updated_at=$5
         WHERE tenant_id=$1 AND id=$2 AND customer_id=$3
           AND total_minor=$6 AND currency=$7`,
        [original.tenant_id,refund.order_id,refund.customer_id,
          refund.proposed_total_minor,input.refundedAtUtc,
          refund.previous_total_minor,refund.currency]
      );
      if (order.rowCount !== 1) {
        await client.query(
          "UPDATE payment_provider_webhook_events SET adjustment_id=$2 WHERE id=$1",
          [receiptId,refund.adjustment_id]
        );
        await this.quarantineRefundReceipt(client,receiptId,"REFUND_ORDER_TOTAL_CONFLICT");
        await client.query("COMMIT");
        return "reconciliation_required";
      }

      await client.query(
        `UPDATE customer_payment_adjustments
         SET status='provider_confirmed',provider_confirmed_at=$3,updated_at=$3
         WHERE tenant_id=$1 AND id=$2 AND status='provider_pending'`,
        [original.tenant_id,refund.adjustment_id,input.refundedAtUtc]
      );
      await client.query(
        `UPDATE payment_adjustment_submission_outbox
         SET status='submitted',completed_at=$3,
             lease_owner=NULL,lease_expires_at=NULL,updated_at=$3
         WHERE tenant_id=$1 AND adjustment_id=$2 AND status='processing'`,
        [original.tenant_id,refund.adjustment_id,now]
      );
      await appendAdjustmentEvent(client,
        {id:refund.adjustment_id,tenant_id:original.tenant_id},
        "payment-webhook-worker","provider_confirmed",input.refundedAtUtc);
      await client.query(
        `UPDATE payment_provider_webhook_events
         SET status='applied',adjustment_id=$2,processed_at=$3,
             failure_code=NULL,lease_owner=NULL,lease_expires_at=NULL
         WHERE id=$1 AND status='received'`,
        [receiptId,refund.adjustment_id,now]
      );
      await client.query("COMMIT");
      return "applied";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async quarantineRefundReceipt(
    client: PostgresClient, receiptId: string, failureCode: string
  ): Promise<void> {
    await client.query(
      `UPDATE payment_provider_webhook_events
       SET status='reconciliation_required',failure_code=$2,
           processed_at=NULL,lease_owner=NULL,lease_expires_at=NULL
       WHERE id=$1 AND status='received'`,
      [receiptId,failureCode]
    );
  }

  /**
   * Applies a normalized provider result and finalizes its inbox receipt in one DB transaction.
   * Call only after signature verification, durable receipt creation, and provider-specific
   * event normalization. The caller must pass the authenticated service actor identity.
   */
  async reconcileAdjustment(input: {
    receiptId: string;
    adjustmentId: string;
    providerKey: string;
    actorId: string;
    workerId: string;
    confirmed: boolean;
    providerReference?: string;
    failureCode?: string;
  }): Promise<"applied" | "failed" | "not_processing" | "conflict"> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.receiptId) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(input.adjustmentId) ||
        !/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(input.actorId) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(input.workerId) ||
        (input.confirmed && (!input.providerReference?.trim() || input.providerReference.length > 240)) ||
        (!input.confirmed && input.failureCode !== undefined && !/^[A-Z0-9_]{1,100}$/.test(input.failureCode))) {
      throw new Error("INVALID_PAYMENT_WEBHOOK_RECONCILIATION");
    }
    const client = await this.pool.connect();
    const now = new Date().toISOString();
    try {
      await client.query("BEGIN");
      const receipt = await client.query<{ id: string; adjustment_id: string | null; provider_key: string; provider_reference: string | null; status: string; lease_owner: string | null; lease_valid: boolean }>(
        "SELECT id,adjustment_id,provider_key,provider_reference,status,lease_owner,(lease_expires_at > now()) AS lease_valid FROM payment_provider_webhook_events WHERE id=$1 FOR UPDATE",
        [input.receiptId]
      );
      if (receipt.rowCount !== 1 || receipt.rows[0]!.status !== "processing" || receipt.rows[0]!.lease_owner !== input.workerId || !receipt.rows[0]!.lease_valid) {
        await client.query("ROLLBACK");
        return "not_processing";
      }
      if (receipt.rows[0]!.adjustment_id !== input.adjustmentId || receipt.rows[0]!.provider_key !== input.providerKey) {
        await client.query("ROLLBACK");
        return "conflict";
      }
      const found = await client.query<{
        id: string; tenant_id: string; order_id: string; customer_id: string;
        currency: string; previous_total_minor: string; proposed_total_minor: string;
        provider_key: string | null; provider_reference: string | null; status: string;
      }>(
        "SELECT id,tenant_id,order_id,customer_id,currency,previous_total_minor,proposed_total_minor,provider_key,provider_reference,status FROM customer_payment_adjustments WHERE id=$1 FOR UPDATE",
        [input.adjustmentId]
      );
      if (found.rowCount !== 1 || found.rows[0]!.status !== "provider_pending") {
        await client.query("ROLLBACK");
        return "conflict";
      }
      const adjustment = found.rows[0]!;
      if (adjustment.provider_key !== input.providerKey || !adjustment.provider_reference ||
          (input.providerReference !== undefined && input.providerReference !== adjustment.provider_reference) ||
          (input.confirmed && input.providerReference !== adjustment.provider_reference) ||
          (receipt.rows[0]!.provider_reference !== null && receipt.rows[0]!.provider_reference !== adjustment.provider_reference)) {
        await client.query("ROLLBACK");
        return "conflict";
      }
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
          "UPDATE payment_provider_webhook_events SET status='applied',processed_at=$2,failure_code=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND status='processing'",
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
        "UPDATE payment_provider_webhook_events SET status='failed',processed_at=$2,failure_code=$3,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND status='processing'",
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

  async claimNext(workerId: string, leaseSeconds = 30): Promise<{
    receiptId: string; providerKey: string; providerEventId: string; adjustmentId: string | null;
    eventType: string | null; normalizedStatus: "succeeded" | "failed" | "ignored" | "unsupported" | null;
    providerReference: string | null; failureCode: string | null; attemptCount: number;
  } | null> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(workerId) ||
        !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) {
      throw new Error("INVALID_PAYMENT_WEBHOOK_LEASE");
    }
    const result = await this.pool.query<{
      id: string; provider_key: string; provider_event_id: string; adjustment_id: string | null;
      event_type: string | null; normalized_status: "succeeded" | "failed" | "ignored" | "unsupported" | null;
      provider_reference: string | null; failure_code: string | null; attempt_count: number;
    }>(
      `WITH candidate AS (
         SELECT id FROM payment_provider_webhook_events
         WHERE attempt_count < 20 AND next_attempt_at <= now()
           AND (status='received' OR (status='processing' AND lease_expires_at <= now()))
         ORDER BY received_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE payment_provider_webhook_events AS event
       SET status='processing', lease_owner=$1,
           lease_expires_at=now()+($2 * interval '1 second'),
           attempt_count=attempt_count+1
       FROM candidate
       WHERE event.id=candidate.id
       RETURNING event.id,event.provider_key,event.provider_event_id,event.adjustment_id,
                 event.event_type,event.normalized_status,event.provider_reference,
                 event.failure_code,event.attempt_count`,
      [workerId, leaseSeconds]
    );
    if (result.rowCount !== 1) return null;
    const row = result.rows[0]!;
    return {
      receiptId: row.id, providerKey: row.provider_key, providerEventId: row.provider_event_id,
      adjustmentId: row.adjustment_id, eventType: row.event_type,
      normalizedStatus: row.normalized_status, providerReference: row.provider_reference,
      failureCode: row.failure_code, attemptCount: Number(row.attempt_count)
    };
  }

  async releaseForRetry(input: {
    receiptId: string; workerId: string; delaySeconds: number; failureCode: string;
  }): Promise<"rescheduled" | "dead_lettered" | "lease_lost"> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.receiptId) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(input.workerId) ||
        !Number.isSafeInteger(input.delaySeconds) || input.delaySeconds < 1 || input.delaySeconds > 86_400 ||
        !/^[A-Z0-9_]{1,100}$/.test(input.failureCode)) {
      throw new Error("INVALID_PAYMENT_WEBHOOK_RETRY");
    }
    const result = await this.pool.query<{ id: string; attempt_count: number }>(
      `UPDATE payment_provider_webhook_events
       SET status=CASE WHEN attempt_count >= 20 THEN 'failed' ELSE 'received' END,
           processed_at=CASE WHEN attempt_count >= 20 THEN now() ELSE NULL END,
           next_attempt_at=CASE WHEN attempt_count >= 20 THEN next_attempt_at ELSE now()+($3 * interval '1 second') END,
           lease_owner=NULL, lease_expires_at=NULL, failure_code=$4
       WHERE id=$1 AND status='processing' AND lease_owner=$2 AND lease_expires_at > now()
       RETURNING id,attempt_count`,
      [input.receiptId, input.workerId, input.delaySeconds, input.failureCode]
    );
    if (result.rowCount !== 1) return "lease_lost";
    return Number(result.rows[0]!.attempt_count) >= 20 ? "dead_lettered" : "rescheduled";
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
    workerId?: string;
  }): Promise<"finalized" | "not_processing"> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.receiptId) ||
        !["applied", "ignored", "failed"].includes(input.status) ||
        (input.failureCode !== undefined && !/^[A-Z0-9_]{1,100}$/.test(input.failureCode))) {
      throw new Error("INVALID_PAYMENT_WEBHOOK_FINALIZATION");
    }
    const result = await this.pool.query<{ id: string }>(
      `UPDATE payment_provider_webhook_events
       SET status=$2, processed_at=now(),
           adjustment_id=COALESCE($3, adjustment_id), failure_code=$4, lease_owner=NULL, lease_expires_at=NULL
       WHERE id=$1 AND status='processing' AND ($5::text IS NULL OR (lease_owner=$5 AND lease_expires_at > now()))
       RETURNING id`,
      [input.receiptId, input.status, input.adjustmentId ?? null, input.failureCode ?? null, input.workerId ?? null]
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
