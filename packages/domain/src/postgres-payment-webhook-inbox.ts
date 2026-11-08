import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

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
  }): Promise<PaymentWebhookReceipt> {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey) ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(input.providerEventId) ||
        typeof input.rawBody !== "string" || input.rawBody.length === 0 ||
        Buffer.byteLength(input.rawBody, "utf8") > 65_536 ||
        (input.adjustmentId !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(input.adjustmentId))) {
      throw new Error("INVALID_PAYMENT_WEBHOOK_RECEIPT");
    }
    const digest = createSha256(input.rawBody);
    const id = randomUUID();
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO payment_provider_webhook_events
       (id, provider_key, provider_event_id, payload_sha256, status, adjustment_id)
       VALUES ($1,$2,$3,$4,'received',$5)
       ON CONFLICT (provider_key, provider_event_id) DO NOTHING
       RETURNING id`,
      [id, input.providerKey, input.providerEventId, digest, input.adjustmentId ?? null]
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
