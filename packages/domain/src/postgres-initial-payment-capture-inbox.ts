import { createHash, randomUUID } from "node:crypto";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";

export interface InitialCaptureInboxInput {
  providerKey: string;
  providerEventId: string;
  paymentIntentId: string;
  rawBody: string;
  providerPaymentReference: string;
  amountMinor: number;
  currency: string;
  capturedAtUtc: string;
}
export type InitialCaptureInboxReceipt =
  | { outcome: "received"; receiptId: string }
  | { outcome: "duplicate"; receiptId: string }
  | { outcome: "event_id_collision" };

/** Durable queue for already signature-verified and provider-decoded capture events. */
export class PostgresInitialPaymentCaptureInbox {
  constructor(private readonly pool: PostgresPool, private readonly createId: () => string = randomUUID) {}

  async recordVerified(input: InitialCaptureInboxInput): Promise<InitialCaptureInboxReceipt> {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey) ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(input.providerEventId) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(input.paymentIntentId) ||
        !input.rawBody || Buffer.byteLength(input.rawBody, "utf8") > 65_536 ||
        !input.providerPaymentReference.trim() || input.providerPaymentReference.length > 240 ||
        !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 ||
        !/^[A-Z]{3}$/.test(input.currency) || !Number.isFinite(Date.parse(input.capturedAtUtc))) {
      throw new Error("INVALID_INITIAL_CAPTURE_WEBHOOK_RECEIPT");
    }
    const digest = createHash("sha256").update(input.rawBody, "utf8").digest("hex");
    const id = this.createId();
    const inserted = await this.pool.query<{id:string}>(
      `INSERT INTO initial_payment_capture_webhook_events
       (id,provider_key,provider_event_id,payment_intent_id,payload_sha256,event_type,
        provider_payment_reference,amount_minor,currency,captured_at)
       VALUES ($1,$2,$3,$4,$5,'payment.captured',$6,$7,$8,$9)
       ON CONFLICT (provider_key,provider_event_id) DO NOTHING RETURNING id`,
      [id,input.providerKey,input.providerEventId,input.paymentIntentId,digest,
        input.providerPaymentReference,input.amountMinor,input.currency,input.capturedAtUtc]
    );
    if (inserted.rowCount === 1) return {outcome:"received",receiptId:inserted.rows[0]!.id};
    const existing = await this.pool.query<{
      id:string;payment_intent_id:string;payload_sha256:string;provider_payment_reference:string;
      amount_minor:string|number;currency:string;captured_at:Date|string;
    }>(
      `SELECT id,payment_intent_id,payload_sha256,provider_payment_reference,amount_minor,currency,captured_at
       FROM initial_payment_capture_webhook_events WHERE provider_key=$1 AND provider_event_id=$2`,
      [input.providerKey,input.providerEventId]
    );
    if (existing.rowCount !== 1) throw new Error("INITIAL_CAPTURE_WEBHOOK_LOOKUP_FAILED");
    const row=existing.rows[0]!;
    const same=row.payment_intent_id===input.paymentIntentId && row.payload_sha256===digest &&
      row.provider_payment_reference===input.providerPaymentReference &&
      Number(row.amount_minor)===input.amountMinor && row.currency===input.currency &&
      new Date(row.captured_at).toISOString()===new Date(input.capturedAtUtc).toISOString();
    return same ? {outcome:"duplicate",receiptId:row.id} : {outcome:"event_id_collision"};
  }

  async claimNext(workerId:string,leaseSeconds=30):Promise<ClaimedInitialCapture|null> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(workerId) ||
        !Number.isSafeInteger(leaseSeconds) || leaseSeconds<5 || leaseSeconds>300) {
      throw new Error("INVALID_INITIAL_CAPTURE_WEBHOOK_LEASE");
    }
    const result=await this.pool.query<InitialCaptureRow>(
      `WITH candidate AS (
         SELECT id FROM initial_payment_capture_webhook_events
         WHERE attempt_count<20 AND next_attempt_at<=now()
           AND (status='received' OR (status='processing' AND lease_expires_at<=now()))
         ORDER BY received_at,id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE initial_payment_capture_webhook_events e
       SET status='processing',lease_owner=$1,lease_expires_at=now()+($2 * interval '1 second'),
           attempt_count=attempt_count+1
       FROM candidate WHERE e.id=candidate.id
       RETURNING e.id,e.provider_key,e.provider_event_id,e.payment_intent_id,
         e.provider_payment_reference,e.amount_minor,e.currency,e.captured_at,e.attempt_count`,
      [workerId,leaseSeconds]
    );
    if(result.rowCount!==1)return null;
    return mapClaim(result.rows[0]!);
  }

  /** Insert immutable capture evidence and finalize its inbox receipt atomically. */
  async applyClaimed(input:{receiptId:string;workerId:string}):Promise<"applied"|"duplicate"|"conflict"|"lease_lost"> {
    const client=await this.pool.connect();
    try {
      await client.query("BEGIN");
      const receipt=await client.query<InitialCaptureRow & {status:string;lease_owner:string|null;lease_valid:boolean}>(
        `SELECT id,provider_key,provider_event_id,payment_intent_id,provider_payment_reference,
          amount_minor,currency,captured_at,attempt_count,status,lease_owner,
          (lease_expires_at > now()) AS lease_valid
         FROM initial_payment_capture_webhook_events WHERE id=$1 FOR UPDATE`,
        [input.receiptId]
      );
      if(receipt.rowCount!==1 || receipt.rows[0]!.status!=="processing" ||
         receipt.rows[0]!.lease_owner!==input.workerId || !receipt.rows[0]!.lease_valid) {
        await client.query("ROLLBACK"); return "lease_lost";
      }
      const event=receipt.rows[0]!;
      const intent=await client.query<{
        tenant_id:string;order_id:string;provider_key:string;provider_payment_reference:string;
        amount_minor:string|number;currency:string;created_at:Date|string;order_status:string;
      }>(
        `SELECT i.tenant_id,i.order_id,i.provider_key,i.provider_payment_reference,i.amount_minor,
          i.currency,i.created_at,o.status AS order_status
         FROM provider_payment_intents i
         JOIN customer_orders o ON o.tenant_id=i.tenant_id AND o.id=i.order_id
         WHERE i.id=$1 FOR UPDATE OF i,o`,
        [event.payment_intent_id]
      );
      if(intent.rowCount!==1) { await this.failLocked(client,input.receiptId,"PAYMENT_INTENT_NOT_FOUND"); await client.query("COMMIT"); return "conflict"; }
      const payment=intent.rows[0]!;
      if(payment.provider_key!==event.provider_key ||
         payment.provider_payment_reference!==event.provider_payment_reference ||
         Number(payment.amount_minor)!==Number(event.amount_minor) ||
         payment.currency!==event.currency || dateMillis(event.captured_at)<dateMillis(payment.created_at) ||
         payment.order_status!=="awaiting_payment") {
        await this.failLocked(client,input.receiptId,"PAYMENT_INTENT_MISMATCH");
        await client.query("COMMIT"); return "conflict";
      }
      const captureId=this.createId();
      const inserted=await client.query<{id:string}>(
        `INSERT INTO verified_order_payment_captures
         (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,
          amount_minor,currency,captured_at,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING RETURNING id`,
        [captureId,payment.tenant_id,payment.order_id,event.provider_key,event.provider_event_id,
          event.provider_payment_reference,event.amount_minor,event.currency,event.captured_at,
          `payment-capture:${event.provider_key}:${event.provider_event_id}`]
      );
      let outcome:"applied"|"duplicate"="applied";
      if(inserted.rowCount!==1) {
        const prior=await client.query<{id:string;tenant_id:string;order_id:string;provider_key:string;
          provider_event_id:string;provider_payment_reference:string;amount_minor:string|number;
          currency:string;captured_at:Date|string;idempotency_key:string}>(
          `SELECT id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,
            amount_minor,currency,captured_at,idempotency_key FROM verified_order_payment_captures
           WHERE (provider_key=$1 AND provider_event_id=$2)
              OR (provider_key=$1 AND provider_payment_reference=$3)
              OR (tenant_id=$4 AND order_id=$5 AND idempotency_key=$6)`,
          [event.provider_key,event.provider_event_id,event.provider_payment_reference,
            payment.tenant_id,payment.order_id,`payment-capture:${event.provider_key}:${event.provider_event_id}`]
        );
        if(prior.rowCount===0) throw new Error("INITIAL_CAPTURE_LEDGER_CONFLICT_LOOKUP_FAILED");
        if(prior.rowCount!==1) {
          await this.failLocked(client,input.receiptId,"CAPTURE_IDENTITY_COLLISION");
          await client.query("COMMIT"); return "conflict";
        }
        const p=prior.rows[0]!;
        const same=p.tenant_id===payment.tenant_id && p.order_id===payment.order_id &&
          p.provider_key===event.provider_key && p.provider_event_id===event.provider_event_id &&
          p.provider_payment_reference===event.provider_payment_reference &&
          Number(p.amount_minor)===Number(event.amount_minor) && p.currency===event.currency &&
          dateIso(p.captured_at)===dateIso(event.captured_at) &&
          p.idempotency_key===`payment-capture:${event.provider_key}:${event.provider_event_id}`;
        if(!same) {
          await this.failLocked(client,input.receiptId,"CAPTURE_IDENTITY_COLLISION");
          await client.query("COMMIT"); return "conflict";
        }
        outcome="duplicate";
      }
      const finalized=await client.query(
        `UPDATE initial_payment_capture_webhook_events
         SET status='applied',processed_at=now(),lease_owner=NULL,lease_expires_at=NULL,failure_code=NULL
         WHERE id=$1 AND status='processing' AND lease_owner=$2 AND lease_expires_at>now()`,
        [input.receiptId,input.workerId]
      );
      if(finalized.rowCount!==1) throw new Error("INITIAL_CAPTURE_WEBHOOK_LEASE_LOST");
      await client.query("COMMIT");
      return outcome;
    } catch(error) {
      await client.query("ROLLBACK").catch(()=>undefined);
      throw error;
    } finally { client.release(); }
  }

  async releaseForRetry(input:{receiptId:string;workerId:string;delaySeconds:number;failureCode:string}):
    Promise<"rescheduled"|"dead_lettered"|"lease_lost"> {
    if(!Number.isSafeInteger(input.delaySeconds)||input.delaySeconds<1||input.delaySeconds>86_400||
       !/^[A-Z0-9_]{1,100}$/.test(input.failureCode)) throw new Error("INVALID_INITIAL_CAPTURE_RETRY");
    const r=await this.pool.query<{attempt_count:number}>(
      `UPDATE initial_payment_capture_webhook_events SET
       status=CASE WHEN attempt_count>=20 THEN 'failed' ELSE 'received' END,
       processed_at=CASE WHEN attempt_count>=20 THEN now() ELSE NULL END,
       next_attempt_at=CASE WHEN attempt_count>=20 THEN next_attempt_at ELSE now()+($3 * interval '1 second') END,
       lease_owner=NULL,lease_expires_at=NULL,failure_code=$4
       WHERE id=$1 AND status='processing' AND lease_owner=$2 AND lease_expires_at>now() RETURNING attempt_count`,
      [input.receiptId,input.workerId,input.delaySeconds,input.failureCode]
    );
    if(r.rowCount!==1)return "lease_lost";
    return Number(r.rows[0]!.attempt_count)>=20?"dead_lettered":"rescheduled";
  }

  private async failLocked(client:PostgresClient,receiptId:string,code:string):Promise<void> {
    await client.query(
      `UPDATE initial_payment_capture_webhook_events
       SET status='failed',processed_at=now(),failure_code=$2,lease_owner=NULL,lease_expires_at=NULL
       WHERE id=$1 AND status='processing'`,[receiptId,code]
    );
  }
}

type InitialCaptureRow={id:string;provider_key:string;provider_event_id:string;payment_intent_id:string;
  provider_payment_reference:string;amount_minor:string|number;currency:string;captured_at:Date|string;attempt_count:number};
export type ClaimedInitialCapture={receiptId:string;providerKey:string;providerEventId:string;paymentIntentId:string;
  providerPaymentReference:string;amountMinor:number;currency:string;capturedAtUtc:string;attemptCount:number};
function dateMillis(value:Date|string):number { return value instanceof Date ? value.getTime() : Date.parse(value); }
function dateIso(value:Date|string):string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function mapClaim(r:InitialCaptureRow):ClaimedInitialCapture {
  return {receiptId:r.id,providerKey:r.provider_key,providerEventId:r.provider_event_id,
    paymentIntentId:r.payment_intent_id,providerPaymentReference:r.provider_payment_reference,
    amountMinor:Number(r.amount_minor),currency:r.currency,
    capturedAtUtc:dateIso(r.captured_at),attemptCount:Number(r.attempt_count)};
}

export class InitialPaymentCaptureWebhookWorker {
  constructor(private readonly store:PostgresInitialPaymentCaptureInbox,private readonly workerId:string,
    private readonly leaseSeconds=30) {
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(workerId)||!Number.isSafeInteger(leaseSeconds)||
       leaseSeconds<5||leaseSeconds>300) throw new Error("INVALID_INITIAL_CAPTURE_WORKER_CONFIGURATION");
  }
  async runOnce():Promise<{outcome:"idle"|"applied"|"duplicate"|"conflict"|"retry_scheduled"|"dead_lettered"|"lease_lost";receiptId?:string}> {
    const event=await this.store.claimNext(this.workerId,this.leaseSeconds);
    if(!event)return {outcome:"idle"};
    try {
      const result=await this.store.applyClaimed({receiptId:event.receiptId,workerId:this.workerId});
      return {outcome:result,receiptId:event.receiptId};
    } catch {
      const delay=Math.min(3600,5*2**Math.min(Math.max(event.attemptCount-1,0),9));
      const retry=await this.store.releaseForRetry({receiptId:event.receiptId,workerId:this.workerId,
        delaySeconds:delay,failureCode:"CAPTURE_RECONCILIATION_RETRY"});
      return {outcome:retry==="rescheduled"?"retry_scheduled":retry==="dead_lettered"?"dead_lettered":"lease_lost",
        receiptId:event.receiptId};
    }
  }
}
