import { randomUUID } from "node:crypto";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";
import type { PaymentAdjustmentCommand } from "./payment-adjustment-provider.js";

export type ClaimedPaymentAdjustmentSubmission = {
  submissionId:string; tenantId:string; adjustmentId:string; providerKey:string;
  idempotencyKey:string; attemptCount:number; command:PaymentAdjustmentCommand;
};

export class PostgresPaymentAdjustmentSubmissionOutbox {
  constructor(private readonly pool:PostgresPool,private readonly now:()=>Date=()=>new Date()){}

  async claimNext(workerId:string,providerKey:string,leaseSeconds=30):Promise<ClaimedPaymentAdjustmentSubmission|null>{
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(workerId)||!/^[a-zA-Z0-9._-]{1,100}$/.test(providerKey)||!Number.isSafeInteger(leaseSeconds)||leaseSeconds<5||leaseSeconds>300)
      throw new Error("INVALID_PAYMENT_ADJUSTMENT_OUTBOX_LEASE");
    const result=await this.pool.query<{
      id:string;tenant_id:string;adjustment_id:string;provider_key:string;idempotency_key:string;
      attempt_count:number;order_id:string;customer_id:string;adjustment_direction:"additional_charge"|"refund";
      amount_minor:string;currency:string;original_payment_reference:string|null;expected_refunded_minor:string;
    }>(`WITH expired AS (
        -- A worker may have reached the PSP before its lease expired or process died.
        -- The outcome is therefore ambiguous: quarantine, never submit it a second time.
        UPDATE payment_adjustment_submission_outbox
        SET status='reconciliation_required',lease_owner=NULL,lease_expires_at=NULL,
            last_error_code='PAYMENT_ADJUSTMENT_LEASE_EXPIRED_REQUIRES_RECONCILIATION',updated_at=now()
        WHERE status='processing' AND lease_expires_at <= now()
        RETURNING id
      ), candidate AS (
        SELECT o.id FROM payment_adjustment_submission_outbox AS o
        JOIN customer_payment_adjustments AS a
          ON a.tenant_id=o.tenant_id AND a.id=o.adjustment_id
        WHERE o.status='queued' AND o.attempt_count < 10 AND o.available_at <= now()
          AND o.provider_key=$3
          AND a.status='provider_pending' AND a.provider_key=o.provider_key
          AND a.provider_reference IS NULL
          AND (a.adjustment_direction <> 'refund' OR (
            o.original_payment_reference IS NOT NULL AND EXISTS (
              SELECT 1 FROM payment_refund_reservations AS r
              WHERE r.tenant_id=o.tenant_id AND r.adjustment_id=o.adjustment_id
                AND r.provider_key=o.provider_key
                AND r.original_payment_reference=o.original_payment_reference
                AND r.status='reserved'
            )
          ))
        ORDER BY o.available_at,o.created_at,o.id
        FOR UPDATE OF o SKIP LOCKED LIMIT 1
      )
      UPDATE payment_adjustment_submission_outbox AS o
      SET status='processing',lease_owner=$1,lease_expires_at=now()+($2 * interval '1 second'),
          attempt_count=o.attempt_count+1,updated_at=now()
      FROM candidate,customer_payment_adjustments AS a
      WHERE o.id=candidate.id AND a.tenant_id=o.tenant_id AND a.id=o.adjustment_id
      RETURNING o.id,o.tenant_id,o.adjustment_id,o.provider_key,o.idempotency_key,o.attempt_count,
        a.order_id,a.customer_id,a.adjustment_direction,a.amount_minor,a.currency,o.original_payment_reference,
        (SELECT COALESCE(SUM(r.amount_minor),0)::text FROM payment_refund_reservations r
         WHERE r.tenant_id=o.tenant_id AND r.provider_key=o.provider_key
           AND r.original_payment_reference=o.original_payment_reference AND r.status='confirmed') AS expected_refunded_minor`,
      [workerId,leaseSeconds,providerKey]);
    if(result.rowCount!==1)return null;
    const row=result.rows[0]!;
    const amount=Number(row.amount_minor);
    const expectedRefunded=Number(row.expected_refunded_minor);
    if(!Number.isSafeInteger(amount)||amount<=0)throw new Error("PAYMENT_ADJUSTMENT_AMOUNT_INVALID");
    if(row.adjustment_direction==="refund"&&(!Number.isSafeInteger(expectedRefunded)||expectedRefunded<0))
      throw new Error("PAYMENT_ADJUSTMENT_EXPECTED_REFUND_TOTAL_INVALID");
    return {
      submissionId:row.id,tenantId:row.tenant_id,adjustmentId:row.adjustment_id,
      providerKey:row.provider_key,idempotencyKey:row.idempotency_key,attemptCount:Number(row.attempt_count),
      command:{adjustmentId:row.adjustment_id,orderId:row.order_id,idempotencyKey:row.idempotency_key,
        direction:row.adjustment_direction,amountMinor:amount,currency:row.currency,customerId:row.customer_id,
        ...(row.original_payment_reference===null?{}:{
          originalPaymentReference:row.original_payment_reference,
          expectedRefundedMinor:expectedRefunded
        })}
    };
  }

  async recordAccepted(input:{submissionId:string;workerId:string;providerReference?:string;actorId:string}):Promise<"submitted"|"lease_lost"|"conflict">{
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(input.submissionId)||!input.providerReference.trim()||
       input.providerReference.length>240||!/^[a-zA-Z0-9_-]{1,200}$/.test(input.workerId)||
       !input.actorId.trim())throw new Error("INVALID_PAYMENT_ADJUSTMENT_PROVIDER_RESULT");
    const client=await this.pool.connect();const now=this.now().toISOString();
    try{
      await client.query("BEGIN");
      const selected=await client.query<{tenant_id:string;adjustment_id:string;provider_key:string;status:string;lease_owner:string|null;lease_valid:boolean}>(
        "SELECT tenant_id,adjustment_id,provider_key,status,lease_owner,(lease_expires_at>now()) AS lease_valid FROM payment_adjustment_submission_outbox WHERE id=$1 FOR UPDATE",
        [input.submissionId]);
      if(selected.rowCount!==1||selected.rows[0]!.status!=="processing"||
         selected.rows[0]!.lease_owner!==input.workerId||!selected.rows[0]!.lease_valid){
        await client.query("ROLLBACK");return "lease_lost";
      }
      const job=selected.rows[0]!;
      const adjustment=await client.query<{id:string;tenant_id:string;status:string;provider_key:string|null;provider_reference:string|null}>(
        "SELECT id,tenant_id,status,provider_key,provider_reference FROM customer_payment_adjustments WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [job.tenant_id,job.adjustment_id]);
      if(adjustment.rowCount!==1||adjustment.rows[0]!.status!=="provider_pending"||
         adjustment.rows[0]!.provider_key!==job.provider_key||adjustment.rows[0]!.provider_reference!==null){
        await client.query("ROLLBACK");return "conflict";
      }
      await client.query(
        "UPDATE customer_payment_adjustments SET provider_reference=COALESCE(provider_reference,$3),updated_at=$4 WHERE tenant_id=$1 AND id=$2 AND status='provider_pending' AND (provider_reference IS NULL OR provider_reference=$3)",
        [job.tenant_id,job.adjustment_id,input.providerReference ?? null,now]);
      await client.query(
        "INSERT INTO customer_payment_adjustment_events (id,tenant_id,adjustment_id,actor_id,event_type,occurred_at,snapshot) VALUES ($1,$2,$3,$4,'provider_submitted',$5,$6::jsonb)",
        [randomUUID(),job.tenant_id,job.adjustment_id,input.actorId,now,JSON.stringify({
          status:"provider_submitted",providerKey:job.provider_key,
          ...(input.providerReference === undefined ? {} : {providerReference:input.providerReference})
        })]);
      await client.query(
        "UPDATE payment_adjustment_submission_outbox SET status='submitted',provider_reference=COALESCE(provider_reference,$2),completed_at=$3,updated_at=$3,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
        [input.submissionId,input.providerReference ?? null,now]);
      await client.query("COMMIT");return "submitted";
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }

  async recordUnknown(input:{submissionId:string;workerId:string;failureCode:string}):Promise<"reconciliation_required"|"lease_lost">{
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(input.submissionId)||
       !/^[a-zA-Z0-9_-]{1,200}$/.test(input.workerId)||
       !/^[A-Z0-9_.:-]{1,100}$/.test(input.failureCode))
      throw new Error("INVALID_PAYMENT_ADJUSTMENT_UNKNOWN_RESULT");
    const r=await this.pool.query(
      `UPDATE payment_adjustment_submission_outbox
       SET status='reconciliation_required',last_error_code=$3,
           lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND status='processing' AND lease_owner=$2 AND lease_expires_at>now()`,
      [input.submissionId,input.workerId,input.failureCode]);
    return r.rowCount===1?"reconciliation_required":"lease_lost";
  }

  async retry(input:{submissionId:string;workerId:string;failureCode:string;delaySeconds:number}):Promise<"rescheduled"|"dead_lettered"|"lease_lost">{
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(input.submissionId)||!/^[a-zA-Z0-9_-]{1,200}$/.test(input.workerId)||
       !/^[A-Z0-9_.:-]{1,100}$/.test(input.failureCode)||!Number.isSafeInteger(input.delaySeconds)||
       input.delaySeconds<1||input.delaySeconds>86400)throw new Error("INVALID_PAYMENT_ADJUSTMENT_RETRY");
    const r=await this.pool.query<{attempt_count:number;status:string}>(
      `UPDATE payment_adjustment_submission_outbox
       SET status=CASE WHEN attempt_count>=10 THEN 'dead_letter' ELSE 'queued' END,
           available_at=CASE WHEN attempt_count>=10 THEN available_at ELSE now()+($3 * interval '1 second') END,
           last_error_code=$4,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND status='processing' AND lease_owner=$2 AND lease_expires_at>now()
       RETURNING attempt_count,status`,
      [input.submissionId,input.workerId,input.delaySeconds,input.failureCode]);
    if(r.rowCount!==1)return "lease_lost";
    return r.rows[0]!.status==="dead_letter"?"dead_lettered":"rescheduled";
  }

  async recordRejected(input:{submissionId:string;workerId:string;failureCode:string;actorId:string}):Promise<"failed"|"lease_lost"|"conflict">{
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(input.submissionId)||!/^[a-zA-Z0-9_-]{1,200}$/.test(input.workerId)||
       !/^[A-Z0-9_.:-]{1,100}$/.test(input.failureCode)||!input.actorId.trim())
      throw new Error("INVALID_PAYMENT_ADJUSTMENT_PROVIDER_REJECTION");
    const client=await this.pool.connect();const now=this.now().toISOString();
    try{
      await client.query("BEGIN");
      const found=await client.query<{tenant_id:string;adjustment_id:string;provider_key:string;status:string;lease_owner:string|null;lease_valid:boolean}>(
        "SELECT tenant_id,adjustment_id,provider_key,status,lease_owner,(lease_expires_at>now()) AS lease_valid FROM payment_adjustment_submission_outbox WHERE id=$1 FOR UPDATE",
        [input.submissionId]);
      if(found.rowCount!==1||found.rows[0]!.status!=="processing"||found.rows[0]!.lease_owner!==input.workerId||!found.rows[0]!.lease_valid){
        await client.query("ROLLBACK");return "lease_lost";
      }
      const job=found.rows[0]!;
      const a=await client.query<{id:string;status:string;provider_key:string|null}>(
        "SELECT id,status,provider_key FROM customer_payment_adjustments WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [job.tenant_id,job.adjustment_id]);
      if(a.rowCount!==1||a.rows[0]!.status!=="provider_pending"||a.rows[0]!.provider_key!==job.provider_key){
        await client.query("ROLLBACK");return "conflict";
      }
      await client.query(
        "UPDATE customer_payment_adjustments SET status='provider_failed',updated_at=$3 WHERE tenant_id=$1 AND id=$2",
        [job.tenant_id,job.adjustment_id,now]);
      await client.query(
        "INSERT INTO customer_payment_adjustment_events (id,tenant_id,adjustment_id,actor_id,event_type,occurred_at,snapshot) VALUES ($1,$2,$3,$4,'provider_failed',$5,$6::jsonb)",
        [randomUUID(),job.tenant_id,job.adjustment_id,input.actorId,now,JSON.stringify({status:"provider_failed",failureCode:input.failureCode})]);
      await client.query(
        "UPDATE payment_adjustment_submission_outbox SET status='failed',last_error_code=$2,updated_at=$3,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
        [input.submissionId,input.failureCode,now]);
      await client.query("COMMIT");return "failed";
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }
}
