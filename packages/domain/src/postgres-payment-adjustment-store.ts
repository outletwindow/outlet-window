import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

type AdjustmentRow = {
  id: string; tenant_id: string; order_id: string; customer_id: string;
  currency: string; adjustment_direction: "additional_charge" | "refund";
  amount_minor: string; previous_total_minor: string; proposed_total_minor: string;
  status: string; expires_at: Date | string;
};

export type PaymentAdjustmentOutcome =
  | { outcome: "created" | "consented" | "declined" | "provider_pending" | "provider_confirmed" | "provider_failed" | "expired" | "not_found" | "conflict" };

export class PostgresPaymentAdjustmentStore {
  constructor(private readonly pool: PostgresPool, private readonly now: () => Date = () => new Date()) {}

  async createIntent(input: {
    tenantId: string; orderId: string; customerId: string; actorId: string;
    idempotencyKey: string; quoteReference: string; currency: string;
    previousTotalMinor: number; proposedTotalMinor: number; expiresAtUtc: string;
  }): Promise<PaymentAdjustmentOutcome & { adjustmentId?: string; amountMinor?: number; direction?: "additional_charge" | "refund" }> {
    const previous = BigInt(input.previousTotalMinor);
    const proposed = BigInt(input.proposedTotalMinor);
    if (!input.tenantId.trim() || !input.orderId.trim() || !input.customerId.trim() ||
        input.actorId !== input.customerId || !/^[A-Z]{3}$/.test(input.currency) ||
        !input.idempotencyKey.trim() || input.idempotencyKey.length > 200 ||
        !input.quoteReference.trim() || input.quoteReference.length > 240 ||
        !Number.isSafeInteger(input.previousTotalMinor) || !Number.isSafeInteger(input.proposedTotalMinor) ||
        previous < 0n || proposed < 0n || previous === proposed) throw new Error("invalid_payment_adjustment");
    const expires = Date.parse(input.expiresAtUtc);
    const now = this.now();
    if (!Number.isFinite(expires) || expires <= now.getTime() || expires > now.getTime() + 15 * 60_000) {
      throw new Error("invalid_adjustment_expiry");
    }
    const direction = proposed > previous ? "additional_charge" : "refund";
    const amount = Number(proposed > previous ? proposed - previous : previous - proposed);
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const order = await client.query<{ total_minor: string; currency: string }>(
        "SELECT total_minor,currency FROM customer_orders WHERE tenant_id=$1 AND id=$2 AND customer_id=$3 FOR UPDATE",
        [input.tenantId,input.orderId,input.customerId]
      );
      if (order.rowCount !== 1) { await client.query("ROLLBACK"); return { outcome: "not_found" }; }
      if (BigInt(order.rows[0]!.total_minor) !== previous || order.rows[0]!.currency !== input.currency) {
        await client.query("ROLLBACK"); return { outcome: "conflict" };
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO customer_payment_adjustments
         (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
          adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,status,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'awaiting_customer_consent',$12)
         ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id`,
        [id,input.tenantId,input.orderId,input.customerId,input.idempotencyKey,input.quoteReference,
          input.currency,direction,amount,input.previousTotalMinor,input.proposedTotalMinor,input.expiresAtUtc]
      );
      if (inserted.rowCount !== 1) {
        const existing = await client.query<{id:string;amount_minor:string;adjustment_direction:string}>(
          "SELECT id,amount_minor,adjustment_direction FROM customer_payment_adjustments WHERE tenant_id=$1 AND idempotency_key=$2",
          [input.tenantId,input.idempotencyKey]
        );
        await client.query("COMMIT");
        return existing.rowCount === 1 ? {
          outcome: "created", adjustmentId: existing.rows[0]!.id,
          amountMinor: Number(existing.rows[0]!.amount_minor),
          direction: existing.rows[0]!.adjustment_direction as "additional_charge" | "refund"
        } : { outcome: "conflict" };
      }
      await client.query(
        `INSERT INTO customer_payment_adjustment_events
         (id,tenant_id,adjustment_id,actor_id,event_type,occurred_at,snapshot)
         VALUES ($1,$2,$3,$4,'created',$5,$6::jsonb)`,
        [randomUUID(),input.tenantId,id,input.actorId,now.toISOString(),
          JSON.stringify({previousTotalMinor:input.previousTotalMinor,proposedTotalMinor:input.proposedTotalMinor,
            amountMinor:amount,currency:input.currency,quoteReference:input.quoteReference})]
      );
      await client.query("COMMIT");
      return { outcome:"created",adjustmentId:id,amountMinor:amount,direction };
    } catch(error) {
      await client.query("ROLLBACK").catch(()=>undefined); throw error;
    } finally { client.release(); }
  }

  async consent(input: { tenantId:string; adjustmentId:string; customerId:string; nowUtc?:string }): Promise<PaymentAdjustmentOutcome> {
    return this.transitionCustomer(input,"consented");
  }
  async decline(input: { tenantId:string; adjustmentId:string; customerId:string; nowUtc?:string }): Promise<PaymentAdjustmentOutcome> {
    return this.transitionCustomer(input,"declined");
  }
  private async transitionCustomer(input:{tenantId:string;adjustmentId:string;customerId:string;nowUtc?:string}, action:"consented"|"declined"):Promise<PaymentAdjustmentOutcome>{
    const client=await this.pool.connect();const now=input.nowUtc??this.now().toISOString();
    try{
      await client.query("BEGIN");
      const found=await client.query<AdjustmentRow>(
        "SELECT * FROM customer_payment_adjustments WHERE tenant_id=$1 AND id=$2 AND customer_id=$3 FOR UPDATE",
        [input.tenantId,input.adjustmentId,input.customerId]);
      if(found.rowCount!==1){await client.query("ROLLBACK");return{outcome:"not_found"};}
      const row=found.rows[0]!;
      if(row.status!=="awaiting_customer_consent"){await client.query("ROLLBACK");return{outcome:"conflict"};}
      if(Date.parse(String(row.expires_at))<=Date.parse(now)){
        await client.query("UPDATE customer_payment_adjustments SET status='expired',updated_at=$3 WHERE tenant_id=$1 AND id=$2",
          [input.tenantId,input.adjustmentId,now]);
        await this.appendEvent(client,row,input.customerId,"expired",now);
        await client.query("COMMIT");return{outcome:"expired"};
      }
      const status=action==="consented"?"consented":"declined";
      await client.query(
        "UPDATE customer_payment_adjustments SET status=$3,consented_at=CASE WHEN $3='consented' THEN $4 ELSE NULL END,consent_actor_id=CASE WHEN $3='consented' THEN $5 ELSE NULL END,updated_at=$4 WHERE tenant_id=$1 AND id=$2",
        [input.tenantId,input.adjustmentId,status,now,input.customerId]);
      await this.appendEvent(client,row,input.customerId,action==="consented"?"customer_consented":"customer_declined",now);
      await client.query("COMMIT");return{outcome:action};
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }

  async markProviderPending(input:{tenantId:string;adjustmentId:string;actorId:string}):Promise<PaymentAdjustmentOutcome>{
    const client=await this.pool.connect();const now=this.now().toISOString();
    try{
      await client.query("BEGIN");
      const found=await client.query<AdjustmentRow>("SELECT * FROM customer_payment_adjustments WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[input.tenantId,input.adjustmentId]);
      if(found.rowCount!==1){await client.query("ROLLBACK");return{outcome:"not_found"};}
      const row=found.rows[0]!;
      if(row.status!=="consented"){await client.query("ROLLBACK");return{outcome:"conflict"};}
      await client.query("UPDATE customer_payment_adjustments SET status='provider_pending',updated_at=$3 WHERE tenant_id=$1 AND id=$2",[input.tenantId,input.adjustmentId,now]);
      await this.appendEvent(client,row,input.actorId,"provider_submitted",now);
      await client.query("COMMIT");return{outcome:"provider_pending"};
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }

  async recordProviderResult(input:{tenantId:string;adjustmentId:string;actorId:string;confirmed:boolean;providerReference?:string}):Promise<PaymentAdjustmentOutcome>{
    if(input.confirmed&&(!input.providerReference?.trim()||input.providerReference.length>240))throw new Error("provider_reference_required");
    const client=await this.pool.connect();const now=this.now().toISOString();
    try{
      await client.query("BEGIN");
      const found=await client.query<AdjustmentRow>("SELECT * FROM customer_payment_adjustments WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[input.tenantId,input.adjustmentId]);
      if(found.rowCount!==1){await client.query("ROLLBACK");return{outcome:"not_found"};}
      const row=found.rows[0]!;
      if(row.status!=="provider_pending"){await client.query("ROLLBACK");return{outcome:"conflict"};}
      if(input.confirmed){
        const updated=await client.query(
          "UPDATE customer_orders SET total_minor=$4,version=version+1,updated_at=$5 WHERE tenant_id=$1 AND id=$2 AND customer_id=$3 AND total_minor=$6 AND currency=$7",
          [input.tenantId,row.order_id,row.customer_id,row.proposed_total_minor,now,row.previous_total_minor,row.currency]);
        if(updated.rowCount!==1){await client.query("ROLLBACK");return{outcome:"conflict"};}
        await client.query(
          "UPDATE customer_payment_adjustments SET status='provider_confirmed',provider_reference=$3,provider_confirmed_at=$4,updated_at=$4 WHERE tenant_id=$1 AND id=$2",
          [input.tenantId,input.adjustmentId,input.providerReference,now]);
        await this.appendEvent(client,row,input.actorId,"provider_confirmed",now);
        await client.query("COMMIT");return{outcome:"provider_confirmed"};
      }
      await client.query("UPDATE customer_payment_adjustments SET status='provider_failed',updated_at=$3 WHERE tenant_id=$1 AND id=$2",[input.tenantId,input.adjustmentId,now]);
      await this.appendEvent(client,row,input.actorId,"provider_failed",now);
      await client.query("COMMIT");return{outcome:"provider_failed"};
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }

  private async appendEvent(client:{query:(sql:string,values?:unknown[])=>Promise<unknown>},row:AdjustmentRow,actorId:string,eventType:string,occurredAt:string){
    await client.query(
      "INSERT INTO customer_payment_adjustment_events (id,tenant_id,adjustment_id,actor_id,event_type,occurred_at,snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [randomUUID(),row.tenant_id,row.id,actorId,eventType,occurredAt,JSON.stringify({status:eventType})]);
  }
}
