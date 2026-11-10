import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

export interface VerifiedOrderPaymentCaptureInput {
  tenantId: string;
  orderId: string;
  providerKey: string;
  providerEventId: string;
  providerPaymentReference: string;
  amountMinor: number;
  currency: string;
  capturedAtUtc: string;
  idempotencyKey: string;
}

export type VerifiedCaptureWriteResult =
  | { outcome: "inserted"; captureId: string }
  | { outcome: "duplicate"; captureId: string }
  | { outcome: "identity_collision" };

/** Writes evidence only after the caller has completed provider-specific signature and event verification. */
export class PostgresVerifiedOrderPaymentCaptureStore {
  constructor(
    private readonly pool: PostgresPool,
    private readonly createId: () => string = randomUUID
  ) {}

  async recordVerifiedCapture(input: VerifiedOrderPaymentCaptureInput): Promise<VerifiedCaptureWriteResult> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.tenantId) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(input.orderId) ||
        !/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey) ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(input.providerEventId) ||
        !input.providerPaymentReference.trim() || input.providerPaymentReference.length > 240 ||
        !Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0 ||
        !/^[A-Z]{3}$/.test(input.currency) ||
        !Number.isFinite(Date.parse(input.capturedAtUtc)) ||
        !/^[a-zA-Z0-9._:-]{8,240}$/.test(input.idempotencyKey)) {
      throw new Error("INVALID_VERIFIED_ORDER_PAYMENT_CAPTURE");
    }

    const captureId = this.createId();
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO verified_order_payment_captures
       (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,
        amount_minor,currency,captured_at,idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [captureId, input.tenantId, input.orderId, input.providerKey, input.providerEventId,
        input.providerPaymentReference, input.amountMinor, input.currency, input.capturedAtUtc,
        input.idempotencyKey]
    );
    if (inserted.rowCount === 1) return { outcome: "inserted", captureId: inserted.rows[0]!.id };

    const existing = await this.pool.query<{
      id: string; tenant_id: string; order_id: string; provider_key: string;
      provider_event_id: string; provider_payment_reference: string; amount_minor: string | number;
      currency: string; captured_at: Date | string; idempotency_key: string;
    }>(
      `SELECT id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,
              amount_minor,currency,captured_at,idempotency_key
       FROM verified_order_payment_captures
       WHERE (provider_key=$1 AND provider_event_id=$2)
          OR (provider_key=$1 AND provider_payment_reference=$3)
          OR (tenant_id=$4 AND order_id=$5 AND idempotency_key=$6)
       ORDER BY verified_at`,
      [input.providerKey, input.providerEventId, input.providerPaymentReference,
        input.tenantId, input.orderId, input.idempotencyKey]
    );
    if (existing.rowCount !== 1) throw new Error("VERIFIED_CAPTURE_CONFLICT_LOOKUP_FAILED");
    const row = existing.rows[0]!;
    const same = row.tenant_id === input.tenantId && row.order_id === input.orderId &&
      row.provider_key === input.providerKey && row.provider_event_id === input.providerEventId &&
      row.provider_payment_reference === input.providerPaymentReference &&
      Number(row.amount_minor) === input.amountMinor && row.currency === input.currency &&
      (row.captured_at instanceof Date ? row.captured_at.toISOString() : new Date(row.captured_at).toISOString()) === new Date(input.capturedAtUtc).toISOString() &&
      row.idempotency_key === input.idempotencyKey;
    return same ? { outcome: "duplicate", captureId: row.id } : { outcome: "identity_collision" };
  }
}
