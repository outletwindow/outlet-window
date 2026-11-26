import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";
import type { MerchantPayoutConfirmationEvent } from "./merchant-payout-confirmation-webhook.js";

export interface MerchantPayoutExceptionStore {
  recordVerified(input: {
    eventRowId: string; caseId: string; providerKey: string;
    eventType: "payout_failed" | "payout_canceled" | "payout_returned";
    event: MerchantPayoutConfirmationEvent;
  }): Promise<{ outcome: "recorded" | "duplicate"; caseId: string }>;
}

/** Persists already signature-verified provider exception evidence using the trusted DB function. */
export class PostgresMoyasarMerchantPayoutExceptionStore implements MerchantPayoutExceptionStore {
  constructor(private readonly pool: PostgresPool) {}

  async recordVerified(input: {
    eventRowId: string; caseId: string; providerKey: string;
    eventType: "payout_failed" | "payout_canceled" | "payout_returned";
    event: MerchantPayoutConfirmationEvent;
  }): Promise<{ outcome: "recorded" | "duplicate"; caseId: string }> {
    const event=input.event;
    if (input.providerKey!=="moyasar" ||
      !/^[a-zA-Z0-9._:-]{1,240}$/.test(event.providerEventId) ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(event.outboxId) ||
      !/^[a-zA-Z0-9._:-]{1,240}$/.test(event.providerReference) ||
      !Number.isSafeInteger(event.amountMinor) || event.amountMinor<=0 ||
      !/^[A-Z]{3}$/.test(event.currency) ||
      !event.merchantId || !/^[a-zA-Z0-9._:-]{1,240}$/.test(event.merchantId) ||
      !event.entityId || !/^[a-zA-Z0-9._:-]{1,240}$/.test(event.entityId)) {
      throw new Error("INVALID_MOYASAR_PAYOUT_EXCEPTION");
    }
    const client=await this.pool.connect();
    try {
      await client.query("BEGIN");
      const identity=await client.query<{tenant_id:string}>(
        `SELECT o.tenant_id
         FROM merchant_payout_provider_outbox o
         JOIN merchant_payout_provider_entities e
           ON e.tenant_id=o.tenant_id AND e.merchant_id=o.merchant_id
          AND e.provider_key=o.provider_key AND e.status='active'
         WHERE o.id=$1 AND o.provider_key='moyasar'
          AND e.provider_merchant_id=$2 AND e.provider_entity_id=$3
          AND o.provider_reference=$4 AND o.amount_minor=$5 AND o.currency=$6
          AND (( $7 IN ('payout_failed','payout_canceled') AND o.status='submitted')
            OR ($7='payout_returned' AND o.status='confirmed'))
         FOR UPDATE OF o`,
        [event.outboxId,event.merchantId,event.entityId,event.providerReference,event.amountMinor,event.currency,input.eventType]
      );
      const tenantId=identity.rows[0]?.tenant_id;
      if(!tenantId || identity.rowCount!==1) throw new Error("MOYASAR_PAYOUT_EXCEPTION_IDENTITY_OR_STATE_MISMATCH");

      const existing=await client.query<{outbox_id:string;provider_reference:string;amount_minor:string|number;currency:string;event_type:string;signature_verified:boolean}>(
        `SELECT outbox_id,provider_reference,amount_minor,currency,event_type,signature_verified
         FROM merchant_payout_provider_events
         WHERE tenant_id=$1 AND provider_key='moyasar' AND provider_event_id=$2`,
        [tenantId,event.providerEventId]
      );
      if(existing.rowCount===1){
        const row=existing.rows[0]!;
        if(row.outbox_id!==event.outboxId || row.provider_reference!==event.providerReference ||
          Number(row.amount_minor)!==event.amountMinor || row.currency!==event.currency ||
          row.event_type!==input.eventType || row.signature_verified!==true) {
          throw new Error("MOYASAR_PAYOUT_EXCEPTION_EVENT_COLLISION");
        }
        const found=await client.query<{id:string}>(
          `SELECT id FROM merchant_payout_exception_cases
           WHERE tenant_id=$1 AND provider_key='moyasar' AND provider_event_id=$2`,
          [tenantId,event.providerEventId]
        );
        if(found.rowCount!==1) throw new Error("MOYASAR_PAYOUT_EXCEPTION_CASE_MISSING");
        await client.query("COMMIT");
        return {outcome:"duplicate",caseId:found.rows[0]!.id};
      }
      const result=await client.query<{case_id:string}>(
        `SELECT record_verified_merchant_payout_exception(
          $1,$2,$3,$4,'moyasar',$5,$6,$7,$8,$9
        ) AS case_id`,
        [input.caseId,input.eventRowId,tenantId,event.outboxId,event.providerEventId,
          event.providerReference,input.eventType,event.amountMinor,event.currency]
      );
      const caseId=result.rows[0]?.case_id;
      if(!caseId) throw new Error("MOYASAR_PAYOUT_EXCEPTION_CASE_NOT_CREATED");
      await client.query("COMMIT");
      return {outcome:"recorded",caseId};
    } catch(error) {
      await client.query("ROLLBACK").catch(()=>undefined);
      throw error;
    } finally { client.release(); }
  }
}
