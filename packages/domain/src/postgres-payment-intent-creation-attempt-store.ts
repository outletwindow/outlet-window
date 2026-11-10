import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

export interface BeginPaymentIntentAttemptInput {
  tenantId:string; orderId:string; providerKey:string; idempotencyKey:string;
  amountMinor:number; currency:string;
}
export type BeginPaymentIntentAttemptResult =
  | {outcome:"dispatch";attemptId:string}
  | {outcome:"duplicate";attemptId:string;status:"dispatching"|"outcome_unknown"|"created"|"rejected"}
  | {outcome:"order_attempt_exists";attemptId:string;status:"dispatching"|"outcome_unknown"|"created"}
  | {outcome:"identity_collision"};
type AttemptRow = {
  id:string;tenant_id:string;order_id:string;provider_key:string;idempotency_key:string;
  amount_minor:string|number;currency:string;
  status:"dispatching"|"outcome_unknown"|"created"|"rejected";
  provider_payment_reference:string|null;expires_at:Date|string|null;
};
const valid=(x:BeginPaymentIntentAttemptInput)=>Boolean(x.tenantId.trim()&&x.orderId.trim())&&
  /^[a-zA-Z0-9._-]{1,100}$/.test(x.providerKey)&&/^[a-zA-Z0-9._:-]{8,240}$/.test(x.idempotencyKey)&&
  Number.isSafeInteger(x.amountMinor)&&x.amountMinor>=100&&/^[A-Z]{3}$/.test(x.currency);

export class PostgresPaymentIntentCreationAttemptStore {
  constructor(private readonly pool:PostgresPool,private readonly createId:()=>string=randomUUID){}
  async begin(input:BeginPaymentIntentAttemptInput):Promise<BeginPaymentIntentAttemptResult>{
    if(!valid(input))throw new Error("INVALID_PAYMENT_INTENT_ATTEMPT");
    const id=this.createId();
    const inserted=await this.pool.query<{id:string}>(
      `INSERT INTO payment_intent_creation_attempts
       (id,tenant_id,order_id,provider_key,idempotency_key,amount_minor,currency,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'dispatching') ON CONFLICT DO NOTHING RETURNING id`,
      [id,input.tenantId,input.orderId,input.providerKey,input.idempotencyKey,input.amountMinor,input.currency]);
    if(inserted.rowCount===1)return {outcome:"dispatch",attemptId:inserted.rows[0]!.id};
    const found=await this.pool.query<AttemptRow>(
      `SELECT id,tenant_id,order_id,provider_key,idempotency_key,amount_minor,currency,status,
              provider_payment_reference,expires_at
       FROM payment_intent_creation_attempts
       WHERE (tenant_id=$1 AND idempotency_key=$2)
          OR (tenant_id=$1 AND order_id=$3 AND provider_key=$4
              AND status IN ('dispatching','outcome_unknown','created'))
       ORDER BY created_at`,
      [input.tenantId,input.idempotencyKey,input.orderId,input.providerKey]);
    const exact=found.rows.filter(r=>r.tenant_id===input.tenantId&&r.idempotency_key===input.idempotencyKey);
    if(exact.length>1)return {outcome:"identity_collision"};
    if(exact.length===1){
      const r=exact[0]!;
      const same=r.order_id===input.orderId&&r.provider_key===input.providerKey&&
        Number(r.amount_minor)===input.amountMinor&&r.currency===input.currency;
      return same?{outcome:"duplicate",attemptId:r.id,status:r.status}:{outcome:"identity_collision"};
    }
    const active=found.rows.filter(r=>r.order_id===input.orderId&&r.provider_key===input.providerKey&&
      ["dispatching","outcome_unknown","created"].includes(r.status));
    return active.length===1?{outcome:"order_attempt_exists",attemptId:active[0]!.id,status:active[0]!.status}
      :{outcome:"identity_collision"};
  }
  async markOutcomeUnknown(attemptId:string):Promise<"updated"|"not_dispatching">{
    const r=await this.pool.query(
      `UPDATE payment_intent_creation_attempts SET status='outcome_unknown'
       WHERE id=$1 AND status='dispatching' RETURNING id`,[attemptId]);
    return r.rowCount===1?"updated":"not_dispatching";
  }
  async markRejected(input:{attemptId:string;failureCode:string}):Promise<"updated"|"not_dispatching">{
    if(!/^[A-Z0-9_]{1,80}$/.test(input.failureCode))throw new Error("INVALID_PAYMENT_INTENT_FAILURE_CODE");
    const r=await this.pool.query(
      `UPDATE payment_intent_creation_attempts SET status='rejected',failure_code=$2
       WHERE id=$1 AND status='dispatching' RETURNING id`,[input.attemptId,input.failureCode]);
    return r.rowCount===1?"updated":"not_dispatching";
  }
  /** Only after an authoritative provider lookup proves that no intent was created. */
  async markReconciledRejected(input:{attemptId:string;failureCode:string;providerReconciliationReference:string}):
    Promise<"updated"|"not_unknown">{
    if(!/^[A-Z0-9_]{1,80}$/.test(input.failureCode)||!input.providerReconciliationReference.trim()||
      input.providerReconciliationReference.length>240)throw new Error("INVALID_PAYMENT_INTENT_RECONCILIATION");
    const r=await this.pool.query(
      `UPDATE payment_intent_creation_attempts
       SET status='rejected',failure_code=$2,provider_reconciliation_reference=$3
       WHERE id=$1 AND status='outcome_unknown' RETURNING id`,
      [input.attemptId,input.failureCode,input.providerReconciliationReference]);
    return r.rowCount===1?"updated":"not_unknown";
  }
  /** Persists the provider reference and attempt state in one database transaction. */
  async markCreated(input:{attemptId:string;providerPaymentReference:string;expiresAtUtc:string}):
    Promise<"created"|"not_found"|"conflict">{
    const expiry=Date.parse(input.expiresAtUtc),now=Date.now();
    if(!input.providerPaymentReference.trim()||input.providerPaymentReference.length>240||
      !Number.isFinite(expiry)||expiry<=now||expiry>now+24*60*60_000)throw new Error("INVALID_PAYMENT_INTENT_CREATION_RESULT");
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      const selected=await client.query<AttemptRow>(
        `SELECT id,tenant_id,order_id,provider_key,idempotency_key,amount_minor,currency,status,
                provider_payment_reference,expires_at
         FROM payment_intent_creation_attempts WHERE id=$1 FOR UPDATE`,[input.attemptId]);
      if(selected.rowCount!==1){await client.query("ROLLBACK");return "not_found";}
      const row=selected.rows[0]!;
      if(row.status==="created"){
        const same=row.provider_payment_reference===input.providerPaymentReference&&row.expires_at!==null&&
          new Date(row.expires_at).toISOString()===new Date(input.expiresAtUtc).toISOString();
        await client.query("COMMIT");return same?"created":"conflict";
      }
      if(row.status!=="dispatching"&&row.status!=="outcome_unknown"){await client.query("ROLLBACK");return "conflict";}
      await client.query(
        `INSERT INTO provider_payment_intents
         (id,tenant_id,order_id,provider_key,provider_payment_reference,amount_minor,currency,idempotency_key,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [randomUUID(),row.tenant_id,row.order_id,row.provider_key,input.providerPaymentReference,
          row.amount_minor,row.currency,row.idempotency_key,input.expiresAtUtc]);
      const updated=await client.query(
        `UPDATE payment_intent_creation_attempts SET status='created',provider_payment_reference=$2,expires_at=$3
         WHERE id=$1 AND status IN ('dispatching','outcome_unknown') RETURNING id`,
        [input.attemptId,input.providerPaymentReference,input.expiresAtUtc]);
      if(updated.rowCount!==1)throw new Error("PAYMENT_INTENT_ATTEMPT_STATE_CONFLICT");
      await client.query("COMMIT");return "created";
    }catch(error){
      await client.query("ROLLBACK").catch(()=>undefined);
      if(error instanceof Error&&(error.message.includes("unique")||error.message.includes("duplicate")))return "conflict";
      throw error;
    }finally{client.release();}
  }
}
