import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";
import type { VerifiedMerchantPayoutConfirmationStore } from "./merchant-payout-confirmation-webhook.js";

/**
 * PostgreSQL persistence boundary for verified Moyasar merchant payout events.
 * It resolves the platform merchant/entity pair to one local tenant/merchant
 * before invoking the atomic ledger function from migration 0076.
 */
export class PostgresMoyasarMerchantPayoutConfirmationStore implements VerifiedMerchantPayoutConfirmationStore {
  constructor(private readonly pool: PostgresPool) {}

  async confirmVerified(input: {
    eventRowId: string;
    auditActorId: string;
    providerKey: string;
    providerEventId: string;
    outboxId: string;
    providerReference: string;
    amountMinor: number;
    currency: string;
    merchantId?: string;
    entityId?: string;
  }): Promise<{ outcome: "confirmed" | "duplicate"; journalId: string }> {
    if (input.providerKey !== "moyasar" ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(input.outboxId) ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(input.providerEventId) ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(input.providerReference) ||
        !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 ||
        !/^[A-Z]{3}$/.test(input.currency) ||
        !input.merchantId || !/^[a-zA-Z0-9._:-]{1,240}$/.test(input.merchantId) ||
        !input.entityId || !/^[a-zA-Z0-9._:-]{1,240}$/.test(input.entityId) ||
        !input.auditActorId.trim() || input.auditActorId.length > 160) {
      throw new Error("INVALID_MOYASAR_MERCHANT_PAYOUT_CONFIRMATION");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const identity = await client.query<{ tenant_id: string }>(
        `SELECT o.tenant_id
         FROM merchant_payout_provider_outbox o
         JOIN merchant_payout_provider_entities e
           ON e.tenant_id=o.tenant_id AND e.merchant_id=o.merchant_id
          AND e.provider_key=o.provider_key AND e.status='active'
         WHERE o.id=$1 AND o.provider_key='moyasar'
           AND e.provider_merchant_id=$2 AND e.provider_entity_id=$3
           AND o.provider_reference=$4 AND o.amount_minor=$5 AND o.currency=$6
           AND o.status IN ('submitted','confirmed')
         FOR UPDATE OF o`,
        [input.outboxId,input.merchantId,input.entityId,input.providerReference,input.amountMinor,input.currency]
      );
      const tenantId = identity.rows[0]?.tenant_id;
      if (!tenantId || identity.rowCount !== 1) {
        throw new Error("MOYASAR_PAYOUT_OUTBOX_OR_MERCHANT_IDENTITY_MISMATCH");
      }

      const existing = await client.query<{
        outbox_id: string; provider_reference: string; amount_minor: string | number;
        currency: string; event_type: string; signature_verified: boolean;
      }>(
        `SELECT outbox_id,provider_reference,amount_minor,currency,event_type,signature_verified
         FROM merchant_payout_provider_events
         WHERE tenant_id=$1 AND provider_key='moyasar' AND provider_event_id=$2`,
        [tenantId,input.providerEventId]
      );
      if (existing.rowCount === 1) {
        const row = existing.rows[0]!;
        if (row.outbox_id !== input.outboxId ||
            row.provider_reference !== input.providerReference ||
            Number(row.amount_minor) !== input.amountMinor ||
            row.currency !== input.currency ||
            row.event_type !== "payout_confirmed" || row.signature_verified !== true) {
          throw new Error("MOYASAR_PAYOUT_EVENT_ID_COLLISION");
        }
        const journal = await client.query<{ journal_id: string }>(
          `SELECT id AS journal_id FROM financial_journals
           WHERE tenant_id=$1 AND idempotency_key=$2 AND status='posted'`,
          [tenantId,`merchant-payout:${tenantId}:${input.outboxId}`]
        );
        if (journal.rowCount !== 1) throw new Error("MOYASAR_PAYOUT_DUPLICATE_JOURNAL_MISSING");
        await client.query("COMMIT");
        return { outcome: "duplicate", journalId: journal.rows[0]!.journal_id };
      }

      const posted = await client.query<{ journal_id: string }>(
        `SELECT post_confirmed_merchant_payout(
          $1,$2,$3,'moyasar',$4,$5,$6,$7,$8
        ) AS journal_id`,
        [input.eventRowId || randomUUID(),tenantId,input.outboxId,input.providerEventId,
          input.providerReference,input.amountMinor,input.currency,input.auditActorId]
      );
      const journalId = posted.rows[0]?.journal_id;
      if (!journalId) throw new Error("MOYASAR_PAYOUT_CONFIRMATION_RETURNED_NO_JOURNAL");
      await client.query("COMMIT");
      return { outcome: "confirmed", journalId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
