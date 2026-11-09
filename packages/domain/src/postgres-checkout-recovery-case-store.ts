import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

export type CheckoutRecoveryFailureCode =
  | "INVENTORY_UNAVAILABLE"
  | "INVENTORY_UNGUARANTEED"
  | "TASK_COMMIT_REJECTED";

export interface CheckoutRecoveryCaseInput {
  tenantId: string;
  orderId: string;
  idempotencyKey: string;
  failureCode: CheckoutRecoveryFailureCode;
  failedSuborderId?: string;
  paymentReference: string;
  paymentCapturedAtUtc: string;
  reservationReferences: readonly {
    suborderId: string;
    reservationReference: string;
  }[];
}

export type CheckoutRecoveryCaseWriteResult =
  | { outcome: "recorded"; caseId: string }
  | { outcome: "duplicate"; caseId: string }
  | { outcome: "identity_collision" };

/**
 * Durable handoff for paid checkout failures that need customer/refund resolution.
 * This store never releases stock or issues a refund; those actions require their
 * own verified, auditable workflows.
 */
export class PostgresCheckoutRecoveryCaseStore {
  constructor(
    private readonly pool: PostgresPool,
    private readonly createId: () => string = randomUUID
  ) {}

  async record(input: CheckoutRecoveryCaseInput): Promise<CheckoutRecoveryCaseWriteResult> {
    if (!input.tenantId.trim() || !input.orderId.trim() ||
        !/^[a-zA-Z0-9._:-]{8,240}$/.test(input.idempotencyKey) ||
        !input.paymentReference.trim() || input.paymentReference.length > 240 ||
        !Number.isFinite(Date.parse(input.paymentCapturedAtUtc)) ||
        (input.failedSuborderId !== undefined && !input.failedSuborderId.trim()) ||
        !Array.isArray(input.reservationReferences) ||
        input.reservationReferences.some(item => !item.suborderId.trim() ||
          !item.reservationReference.trim() || item.reservationReference.length > 240)) {
      throw new Error("INVALID_CHECKOUT_RECOVERY_CASE");
    }

    const payload = JSON.stringify(input.reservationReferences);
    const id = this.createId();
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO checkout_recovery_cases
       (id,tenant_id,order_id,idempotency_key,failure_code,failed_suborder_id,
        payment_reference,payment_captured_at,reservation_references)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [id, input.tenantId, input.orderId, input.idempotencyKey, input.failureCode,
        input.failedSuborderId ?? null, input.paymentReference,
        input.paymentCapturedAtUtc, payload]
    );
    if (inserted.rowCount === 1) return { outcome: "recorded", caseId: inserted.rows[0]!.id };

    const existing = await this.pool.query<{
      id: string; tenant_id: string; order_id: string; failure_code: CheckoutRecoveryFailureCode;
      failed_suborder_id: string | null; payment_reference: string;
      payment_captured_at: Date | string; reservation_references: unknown;
    }>(
      `SELECT id,tenant_id,order_id,failure_code,failed_suborder_id,payment_reference,
              payment_captured_at,reservation_references
       FROM checkout_recovery_cases WHERE idempotency_key = $1`,
      [input.idempotencyKey]
    );
    if (existing.rowCount !== 1) throw new Error("CHECKOUT_RECOVERY_CONFLICT_LOOKUP_FAILED");
    const row = existing.rows[0]!;
    const same = row.tenant_id === input.tenantId && row.order_id === input.orderId &&
      row.failure_code === input.failureCode &&
      row.failed_suborder_id === (input.failedSuborderId ?? null) &&
      row.payment_reference === input.paymentReference &&
      new Date(row.payment_captured_at).toISOString() === new Date(input.paymentCapturedAtUtc).toISOString() &&
      JSON.stringify(row.reservation_references) === payload;
    return same ? { outcome: "duplicate", caseId: row.id } : { outcome: "identity_collision" };
  }
}
