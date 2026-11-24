import { randomUUID } from "node:crypto";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";

type AdjustmentRow = {
  id: string; tenant_id: string; order_id: string; customer_id: string;
  currency: string; adjustment_direction: "additional_charge" | "refund";
  amount_minor: string; previous_total_minor: string; proposed_total_minor: string;
  status: string; expires_at: Date | string; provider_key?: string | null; provider_reference?: string | null;
};

export interface RefundComponentAllocationInput {
  suborderId: string;
  componentKind: "product_subtotal" | "delivery";
  amountMinor: number;
  sourceReference?: string;
}

export type PaymentAdjustmentOutcome =
  | { outcome: "created" | "consented" | "declined" | "provider_pending" | "provider_confirmed" | "provider_failed" | "expired" | "not_found" | "conflict" };

export class PostgresPaymentAdjustmentStore {
  constructor(private readonly pool: PostgresPool, private readonly now: () => Date = () => new Date()) {}

  async createIntent(input: {
    tenantId: string; orderId: string; customerId: string; actorId: string;
    idempotencyKey: string; quoteReference: string; currency: string;
    previousTotalMinor: number; proposedTotalMinor: number; expiresAtUtc: string;
    refundAllocations?: readonly RefundComponentAllocationInput[];
  }): Promise<PaymentAdjustmentOutcome & { adjustmentId?: string; amountMinor?: number; direction?: "additional_charge" | "refund" }> {
    if (!input.tenantId.trim() || !input.orderId.trim() || !input.customerId.trim() ||
        input.actorId !== input.customerId || !/^[A-Z]{3}$/.test(input.currency) ||
        !input.idempotencyKey.trim() || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200 ||
        !input.quoteReference.trim() || input.quoteReference.length > 240 ||
        !Number.isSafeInteger(input.previousTotalMinor) || !Number.isSafeInteger(input.proposedTotalMinor) ||
        input.previousTotalMinor < 0 || input.proposedTotalMinor < 0 ||
        input.previousTotalMinor === input.proposedTotalMinor) throw new Error("invalid_payment_adjustment");
    const previous = BigInt(input.previousTotalMinor);
    const proposed = BigInt(input.proposedTotalMinor);
    const expires = Date.parse(input.expiresAtUtc);
    const now = this.now();
    if (!Number.isFinite(expires) || expires <= now.getTime() || expires > now.getTime() + 15 * 60_000) {
      throw new Error("invalid_adjustment_expiry");
    }
    const direction = proposed > previous ? "additional_charge" : "refund";
    const amount = Number(proposed > previous ? proposed - previous : previous - proposed);
    const refundAllocations = input.refundAllocations ?? [];
    if (direction === "refund") {
      if (!Array.isArray(input.refundAllocations) || refundAllocations.length === 0 ||
          refundAllocations.length > 100) throw new Error("refund_component_allocation_required");
      const allocationKeys = new Set<string>();
      let allocatedTotal = 0n;
      for (const allocation of refundAllocations) {
        if (!allocation.suborderId.trim() || allocation.suborderId.length > 200 ||
            !Number.isSafeInteger(allocation.amountMinor) || allocation.amountMinor <= 0 ||
            !["product_subtotal", "delivery"].includes(allocation.componentKind) ||
            (allocation.componentKind === "delivery" &&
              (!allocation.sourceReference?.trim() || allocation.sourceReference.length > 200)) ||
            (allocation.componentKind === "product_subtotal" && allocation.sourceReference !== undefined)) {
          throw new Error("invalid_refund_component_allocation");
        }
        const key = allocation.suborderId + ":" + allocation.componentKind;
        if (allocationKeys.has(key)) throw new Error("duplicate_refund_component_allocation");
        allocationKeys.add(key);
        allocatedTotal += BigInt(allocation.amountMinor);
      }
      if (allocatedTotal !== BigInt(amount)) throw new Error("refund_component_allocation_total_mismatch");
    } else if (refundAllocations.length > 0) {
      throw new Error("additional_charge_must_not_include_refund_allocations");
    }
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
        const existing = await client.query<{id:string;amount_minor:string;adjustment_direction:string;order_id:string;customer_id:string;currency:string;previous_total_minor:string;proposed_total_minor:string;quote_reference:string}>(
          "SELECT id,amount_minor,adjustment_direction,order_id,customer_id,currency,previous_total_minor,proposed_total_minor,quote_reference FROM customer_payment_adjustments WHERE tenant_id=$1 AND idempotency_key=$2",
          [input.tenantId,input.idempotencyKey]
        );
        await client.query("COMMIT");
        if (existing.rowCount !== 1) return { outcome: "conflict" };
        const prior = existing.rows[0]!;
        const existingAllocations = await client.query<{
          suborder_id: string; component_kind: "product_subtotal" | "delivery";
          source_reference: string | null; amount_minor: string;
        }>(
          "SELECT suborder_id,component_kind,source_reference,amount_minor FROM customer_payment_adjustment_allocations WHERE tenant_id=$1 AND adjustment_id=$2 ORDER BY suborder_id,component_kind",
          [input.tenantId,prior.id]
        );
        const expectedAllocations = refundAllocations.map(line => ({
          suborder_id: line.suborderId, component_kind: line.componentKind,
          source_reference: line.sourceReference ?? null, amount_minor: String(line.amountMinor)
        })).sort((a,b) => a.suborder_id.localeCompare(b.suborder_id) || a.component_kind.localeCompare(b.component_kind));
        const priorAllocations = existingAllocations.rows.map(line => ({
          suborder_id: line.suborder_id, component_kind: line.component_kind,
          source_reference: line.source_reference, amount_minor: String(line.amount_minor)
        }));
        const sameAllocations = JSON.stringify(priorAllocations) === JSON.stringify(expectedAllocations);
        const sameRequest = prior.order_id === input.orderId && prior.customer_id === input.customerId &&
          prior.currency === input.currency && BigInt(prior.previous_total_minor) === previous &&
          BigInt(prior.proposed_total_minor) === proposed && prior.quote_reference === input.quoteReference &&
          sameAllocations;
        return sameRequest ? {
          outcome: "created", adjustmentId: prior.id,
          amountMinor: Number(prior.amount_minor),
          direction: prior.adjustment_direction as "additional_charge" | "refund"
        } : { outcome: "conflict" };
      }
      for (const allocation of refundAllocations) {
        await client.query(
          `INSERT INTO customer_payment_adjustment_allocations
           (id,tenant_id,adjustment_id,order_id,suborder_id,component_kind,source_reference,amount_minor,currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [randomUUID(),input.tenantId,id,input.orderId,allocation.suborderId,
            allocation.componentKind,allocation.sourceReference ?? null,allocation.amountMinor,input.currency]
        );
      }
      await client.query(
        `INSERT INTO customer_payment_adjustment_events
         (id,tenant_id,adjustment_id,actor_id,event_type,occurred_at,snapshot)
         VALUES ($1,$2,$3,$4,'created',$5,$6::jsonb)`,
        [randomUUID(),input.tenantId,id,input.actorId,now.toISOString(),
          JSON.stringify({previousTotalMinor:input.previousTotalMinor,proposedTotalMinor:input.proposedTotalMinor,
            amountMinor:amount,currency:input.currency,quoteReference:input.quoteReference,
            refundAllocations})]
      );
      await client.query("COMMIT");
      return { outcome:"created",adjustmentId:id,amountMinor:amount,direction };
    } catch(error) {
      await client.query("ROLLBACK").catch(()=>undefined); throw error;
    } finally { client.release(); }
  }

  async consent(input: { adjustmentId:string; orderId:string; customerId:string; nowUtc?:string }): Promise<PaymentAdjustmentOutcome> {
    return this.transitionCustomer(input,"consented");
  }
  async decline(input: { adjustmentId:string; orderId:string; customerId:string; nowUtc?:string }): Promise<PaymentAdjustmentOutcome> {
    return this.transitionCustomer(input,"declined");
  }
  private async transitionCustomer(input:{adjustmentId:string;orderId:string;customerId:string;nowUtc?:string}, action:"consented"|"declined"):Promise<PaymentAdjustmentOutcome>{
    const client=await this.pool.connect();const now=input.nowUtc??this.now().toISOString();
    try{
      await client.query("BEGIN");
      const found=await client.query<AdjustmentRow>(
        "SELECT * FROM customer_payment_adjustments WHERE id=$1 AND order_id=$2 AND customer_id=$3 FOR UPDATE",
        [input.adjustmentId,input.orderId,input.customerId]);
      if(found.rowCount!==1){await client.query("ROLLBACK");return{outcome:"not_found"};}
      const row=found.rows[0]!;
      if(row.status!=="awaiting_customer_consent"){await client.query("ROLLBACK");return{outcome:"conflict"};}
      if(Date.parse(String(row.expires_at))<=Date.parse(now)){
        await client.query("UPDATE customer_payment_adjustments SET status='expired',updated_at=$2 WHERE id=$1",
          [input.adjustmentId,now]);
        await this.appendEvent(client,row,input.customerId,"expired",now);
        await client.query("COMMIT");return{outcome:"expired"};
      }
      const status=action==="consented"?"consented":"declined";
      await client.query(
        "UPDATE customer_payment_adjustments SET status=$2,consented_at=CASE WHEN $2='consented' THEN $3 ELSE NULL END,consent_actor_id=CASE WHEN $2='consented' THEN $4 ELSE NULL END,updated_at=$3 WHERE id=$1",
        [input.adjustmentId,status,now,input.customerId]);
      await this.appendEvent(client,row,input.customerId,action==="consented"?"customer_consented":"customer_declined",now);
      await client.query("COMMIT");return{outcome:action};
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }

  private async hasVerifiedOriginalCapture(client:PostgresClient,row:AdjustmentRow,providerKey:string):Promise<boolean>{
    if(row.adjustment_direction!=="refund")return true;
    const capture=await client.query(
      `SELECT 1 FROM verified_order_payment_captures
       WHERE tenant_id=$1 AND order_id=$2 AND provider_key=$3
         AND amount_minor >= $4 AND currency=$5
       FOR UPDATE`,
      [row.tenant_id,row.order_id,providerKey,row.amount_minor,row.currency]);
    return capture.rowCount===1 && capture.rows.length===1;
  }

  async consentAndQueue(input:{adjustmentId:string;orderId:string;customerId:string;providerKey:string;nowUtc?:string}):Promise<PaymentAdjustmentOutcome & {submissionId?:string}>{
    if(!/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey))
      throw new Error("invalid_payment_provider");
    const client=await this.pool.connect();
    const now=input.nowUtc??this.now().toISOString();
    const submissionId=randomUUID();
    const idempotencyKey="adjustment-"+randomUUID();
    try{
      await client.query("BEGIN");
      const found=await client.query<AdjustmentRow>(
        "SELECT * FROM customer_payment_adjustments WHERE id=$1 AND order_id=$2 AND customer_id=$3 FOR UPDATE",
        [input.adjustmentId,input.orderId,input.customerId]);
      if(found.rowCount!==1){await client.query("ROLLBACK");return{outcome:"not_found"};}
      const row=found.rows[0]!;
      if(row.status!=="awaiting_customer_consent"){await client.query("ROLLBACK");return{outcome:"conflict"};}
      if(Date.parse(String(row.expires_at))<=Date.parse(now)){
        await client.query("UPDATE customer_payment_adjustments SET status='expired',updated_at=$2 WHERE tenant_id=$1 AND id=$3",
          [row.tenant_id,now,input.adjustmentId]);
        await this.appendEvent(client,row,input.customerId,"expired",now);
        await client.query("COMMIT");return{outcome:"expired"};
      }
      if(!(await this.hasVerifiedOriginalCapture(client,row,input.providerKey))){
        await client.query("ROLLBACK");return{outcome:"conflict"};
      }
      const consented=await client.query(
        "UPDATE customer_payment_adjustments SET status='provider_pending',consented_at=$3,consent_actor_id=$4,provider_key=$5,updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='awaiting_customer_consent'",
        [row.tenant_id,input.adjustmentId,now,input.customerId,input.providerKey]);
      if(consented.rowCount!==1){await client.query("ROLLBACK");return{outcome:"conflict"};}
      await this.appendEvent(client,row,input.customerId,"customer_consented",now);
      await client.query(
        "INSERT INTO payment_adjustment_submission_outbox (id,tenant_id,adjustment_id,provider_key,idempotency_key,status,available_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'queued',$6,$6,$6)",
        [submissionId,row.tenant_id,input.adjustmentId,input.providerKey,idempotencyKey,now]);
      await this.appendEvent(client,row,input.customerId,"provider_submission_queued",now);
      await client.query("COMMIT");
      return{outcome:"provider_pending",submissionId};
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}
    finally{client.release();}
  }

  async queueProviderSubmission(input:{tenantId:string;adjustmentId:string;actorId:string;providerKey:string;idempotencyKey:string}):Promise<PaymentAdjustmentOutcome & { submissionId?:string }>{
    if(!/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey)||
       !/^[a-zA-Z0-9._:-]{8,200}$/.test(input.idempotencyKey)||
       !input.actorId.trim()) throw new Error("invalid_payment_provider_submission");
    const client=await this.pool.connect();const now=this.now().toISOString();const submissionId=randomUUID();
    try{
      await client.query("BEGIN");
      const found=await client.query<AdjustmentRow>(
        "SELECT * FROM customer_payment_adjustments WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [input.tenantId,input.adjustmentId]);
      if(found.rowCount!==1){await client.query("ROLLBACK");return{outcome:"not_found"};}
      const row=found.rows[0]!;
      if(row.status!=="consented"){await client.query("ROLLBACK");return{outcome:"conflict"};}
      if(!(await this.hasVerifiedOriginalCapture(client,row,input.providerKey))){
        await client.query("ROLLBACK");return{outcome:"conflict"};
      }
      const updated=await client.query(
        "UPDATE customer_payment_adjustments SET status='provider_pending',provider_key=$3,updated_at=$4 WHERE tenant_id=$1 AND id=$2 AND status='consented'",
        [input.tenantId,input.adjustmentId,input.providerKey,now]);
      if(updated.rowCount!==1){await client.query("ROLLBACK");return{outcome:"conflict"};}
      await client.query(
        "INSERT INTO payment_adjustment_submission_outbox (id,tenant_id,adjustment_id,provider_key,idempotency_key,status,available_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'queued',$6,$6,$6)",
        [submissionId,input.tenantId,input.adjustmentId,input.providerKey,input.idempotencyKey,now]);
      await this.appendEvent(client,row,input.actorId,"provider_submission_queued",now);
      await client.query("COMMIT");
      return{outcome:"provider_pending",submissionId};
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }

  async markProviderPending(input:{tenantId:string;adjustmentId:string;actorId:string;providerKey:string;providerReference:string}):Promise<PaymentAdjustmentOutcome>{
    if(!/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey)||!input.providerReference.trim()||input.providerReference.length>240) throw new Error("invalid_payment_provider_submission");
    const client=await this.pool.connect();const now=this.now().toISOString();
    try{
      await client.query("BEGIN");
      const found=await client.query<AdjustmentRow>("SELECT * FROM customer_payment_adjustments WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[input.tenantId,input.adjustmentId]);
      if(found.rowCount!==1){await client.query("ROLLBACK");return{outcome:"not_found"};}
      const row=found.rows[0]!;
      if(row.status!=="consented"){await client.query("ROLLBACK");return{outcome:"conflict"};}
      await client.query("UPDATE customer_payment_adjustments SET status='provider_pending',provider_key=$3,provider_reference=$4,updated_at=$5 WHERE tenant_id=$1 AND id=$2",[input.tenantId,input.adjustmentId,input.providerKey,input.providerReference,now]);
      await this.appendEvent(client,row,input.actorId,"provider_submitted",now);
      await client.query("COMMIT");return{outcome:"provider_pending"};
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }

  async recordProviderResult(input:{tenantId:string;adjustmentId:string;actorId:string;providerKey:string;confirmed:boolean;providerReference?:string}):Promise<PaymentAdjustmentOutcome>{
    if(!/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey)) throw new Error("invalid_payment_provider");
    if(input.confirmed&&(!input.providerReference?.trim()||input.providerReference.length>240))throw new Error("provider_reference_required");
    const client=await this.pool.connect();const now=this.now().toISOString();
    try{
      await client.query("BEGIN");
      const found=await client.query<AdjustmentRow>("SELECT * FROM customer_payment_adjustments WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[input.tenantId,input.adjustmentId]);
      if(found.rowCount!==1){await client.query("ROLLBACK");return{outcome:"not_found"};}
      const row=found.rows[0]!;
      if(row.status!=="provider_pending" || row.provider_key !== input.providerKey ||
         !row.provider_reference || (input.providerReference !== undefined && input.providerReference !== row.provider_reference) ||
         (input.confirmed && input.providerReference !== row.provider_reference)){await client.query("ROLLBACK");return{outcome:"conflict"};}
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

  private async appendEvent(client:PostgresClient,row:AdjustmentRow,actorId:string,eventType:string,occurredAt:string):Promise<void>{
    await client.query(
      "INSERT INTO customer_payment_adjustment_events (id,tenant_id,adjustment_id,actor_id,event_type,occurred_at,snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [randomUUID(),row.tenant_id,row.id,actorId,eventType,occurredAt,JSON.stringify({status:eventType})]);
  }
}
