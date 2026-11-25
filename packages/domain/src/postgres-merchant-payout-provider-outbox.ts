import type { PostgresPool } from "./postgres-iam-store.js";

export interface ClaimedMerchantPayout {
  outboxId: string;
  tenantId: string;
  payoutIntentId: string;
  merchantId: string;
  destinationId: string;
  vaultReference: string;
  providerKey: string;
  currency: string;
  amountMinor: number;
  idempotencyKey: string;
  attemptCount: number;
}
export type MerchantPayoutOutboxClaimResult = ClaimedMerchantPayout | null;

/**
 * Durable claim and state transitions for merchant payout submission.
 * This store never treats provider acceptance as a completed transfer.
 */
export class PostgresMerchantPayoutProviderOutbox {
  constructor(private readonly pool: PostgresPool) {}

  async claimNext(workerId: string, providerKey: string, leaseSeconds = 45): Promise<MerchantPayoutOutboxClaimResult> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(workerId) ||
        !/^[a-zA-Z0-9._-]{1,100}$/.test(providerKey) ||
        !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 300) {
      throw new Error("INVALID_MERCHANT_PAYOUT_OUTBOX_LEASE");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Expired processing leases are ambiguous: the provider may already have
      // accepted the transfer. Quarantine them; never submit them a second time.
      await client.query(
        `UPDATE merchant_payout_provider_outbox
         SET status='reconciliation_required', lease_owner=NULL, lease_expires_at=NULL,
             last_error_code='PAYOUT_SUBMISSION_LEASE_EXPIRED', updated_at=now()
         WHERE status='processing' AND lease_expires_at <= now()`
      );
      const result = await client.query<{
        id: string; tenant_id: string; payout_intent_id: string; merchant_id: string;
        destination_id: string; vault_reference: string; provider_key: string;
        currency: string; amount_minor: string | number; idempotency_key: string;
        attempt_count: number;
      }>(
        `WITH candidate AS (
           SELECT o.id
           FROM merchant_payout_provider_outbox o
           JOIN merchant_payout_intents i
             ON i.tenant_id=o.tenant_id AND i.id=o.payout_intent_id
           JOIN merchant_payout_destinations d
             ON d.tenant_id=o.tenant_id AND d.merchant_id=o.merchant_id AND d.id=o.destination_id
           WHERE o.status='queued' AND o.available_at<=now()
             AND o.attempt_count<8 AND o.provider_key=$2
             AND i.status='authorized'
             AND i.amount_minor=o.amount_minor AND i.currency=o.currency
             AND d.provider_key=o.provider_key AND d.currency=o.currency
             AND d.verification_status='verified'
           ORDER BY o.available_at,o.created_at,o.id
           FOR UPDATE OF o SKIP LOCKED LIMIT 1
         )
         UPDATE merchant_payout_provider_outbox o
         SET status='processing',lease_owner=$1,
             lease_expires_at=now()+($3 * interval '1 second'),
             attempt_count=o.attempt_count+1,updated_at=now()
         FROM candidate c,merchant_payout_destinations d
         WHERE o.id=c.id AND d.tenant_id=o.tenant_id
           AND d.merchant_id=o.merchant_id AND d.id=o.destination_id
           AND d.verification_status='verified'
         RETURNING o.id,o.tenant_id,o.payout_intent_id,o.merchant_id,o.destination_id,
           d.vault_reference,o.provider_key,o.currency,o.amount_minor,o.idempotency_key,o.attempt_count`,
        [workerId,providerKey,leaseSeconds]
      );
      await client.query("COMMIT");
      if (result.rowCount !== 1) return null;
      const row = result.rows[0]!;
      const amountMinor = Number(row.amount_minor);
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
        throw new Error("MERCHANT_PAYOUT_AMOUNT_OUT_OF_RANGE");
      }
      return {
        outboxId: row.id, tenantId: row.tenant_id, payoutIntentId: row.payout_intent_id,
        merchantId: row.merchant_id, destinationId: row.destination_id,
        vaultReference: row.vault_reference, providerKey: row.provider_key,
        currency: row.currency, amountMinor, idempotencyKey: row.idempotency_key,
        attemptCount: Number(row.attempt_count)
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordSubmitted(input: {
    outboxId: string; workerId: string; providerReference: string;
  }): Promise<"submitted" | "lease_lost" | "conflict"> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.outboxId) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(input.workerId) ||
        !input.providerReference.trim() || input.providerReference.length > 240) {
      throw new Error("INVALID_MERCHANT_PAYOUT_PROVIDER_ACCEPTANCE");
    }
    const result = await this.pool.query(
      `UPDATE merchant_payout_provider_outbox
       SET status='submitted',provider_reference=$3,submitted_at=now(),
           lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND status='processing' AND lease_owner=$2
         AND lease_expires_at>now() AND provider_reference IS NULL`,
      [input.outboxId,input.workerId,input.providerReference]
    );
    return result.rowCount === 1 ? "submitted" : "lease_lost";
  }

  async recordUnknown(input: {
    outboxId: string; workerId: string; failureCode: string;
  }): Promise<"reconciliation_required" | "lease_lost"> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.outboxId) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(input.workerId) ||
        !/^[A-Z0-9_.:-]{1,100}$/.test(input.failureCode)) {
      throw new Error("INVALID_MERCHANT_PAYOUT_UNKNOWN_RESULT");
    }
    const result = await this.pool.query(
      `UPDATE merchant_payout_provider_outbox
       SET status='reconciliation_required',last_error_code=$3,
           lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND status='processing' AND lease_owner=$2 AND lease_expires_at>now()`,
      [input.outboxId,input.workerId,input.failureCode]
    );
    return result.rowCount === 1 ? "reconciliation_required" : "lease_lost";
  }

  async recordRetry(input: {
    outboxId: string; workerId: string; failureCode: string; delaySeconds: number;
  }): Promise<"rescheduled" | "dead_lettered" | "lease_lost"> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.outboxId) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(input.workerId) ||
        !/^[A-Z0-9_.:-]{1,100}$/.test(input.failureCode) ||
        !Number.isSafeInteger(input.delaySeconds) || input.delaySeconds < 1 || input.delaySeconds > 86_400) {
      throw new Error("INVALID_MERCHANT_PAYOUT_RETRY");
    }
    const result = await this.pool.query<{status:string}>(
      `UPDATE merchant_payout_provider_outbox
       SET status=CASE WHEN attempt_count>=8 THEN 'failed' ELSE 'queued' END,
           available_at=CASE WHEN attempt_count>=8 THEN available_at
             ELSE now()+($3 * interval '1 second') END,
           last_error_code=$4,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND status='processing' AND lease_owner=$2 AND lease_expires_at>now()
       RETURNING status`,
      [input.outboxId,input.workerId,input.delaySeconds,input.failureCode]
    );
    if (result.rowCount !== 1) return "lease_lost";
    return result.rows[0]!.status === "failed" ? "dead_lettered" : "rescheduled";
  }
  async recordRejected(input: {
    outboxId: string; workerId: string; failureCode: string;
  }): Promise<"failed" | "lease_lost"> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.outboxId) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(input.workerId) ||
        !/^[A-Z0-9_.:-]{1,100}$/.test(input.failureCode)) {
      throw new Error("INVALID_MERCHANT_PAYOUT_PROVIDER_REJECTION");
    }
    const result = await this.pool.query(
      `UPDATE merchant_payout_provider_outbox
       SET status='failed',last_error_code=$3,lease_owner=NULL,
           lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND status='processing' AND lease_owner=$2 AND lease_expires_at>now()`,
      [input.outboxId,input.workerId,input.failureCode]
    );
    return result.rowCount === 1 ? "failed" : "lease_lost";
  }

}
