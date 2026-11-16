import { describe,expect,it,vi } from "vitest";
import type { PostgresClient,PostgresPool } from "./postgres-iam-store.js";
import { PostgresPaymentAdjustmentSubmissionOutbox } from "./postgres-payment-adjustment-submission-outbox.js";

function fixture(options:{leaseValid?:boolean;adjustmentStatus?:string;adjustmentProviderKey?:string|null}={}){
  const calls:Array<{sql:string;params?:unknown[]}>=[];
  const query=vi.fn(async(sql:string,params?:unknown[])=>{
    calls.push({sql,...(params===undefined?{}:{params})});
    if(sql.includes("SELECT tenant_id,adjustment_id,provider_key,status,lease_owner")){
      return {rows:[{tenant_id:"tenant-1",adjustment_id:"adjustment-1",provider_key:"moyasar",
        status:"processing",lease_owner:"worker-1",lease_valid:options.leaseValid??true}],rowCount:1};
    }
    if(sql.includes("SELECT id,tenant_id,status,provider_key,provider_reference FROM customer_payment_adjustments")){
      return {rows:[{id:"adjustment-1",tenant_id:"tenant-1",status:options.adjustmentStatus??"provider_pending",
        provider_key:options.adjustmentProviderKey??"moyasar",provider_reference:null}],rowCount:1};
    }
    if(sql.includes("SELECT id,status,provider_key FROM customer_payment_adjustments")){
      return {rows:[{id:"adjustment-1",status:options.adjustmentStatus??"provider_pending",
        provider_key:options.adjustmentProviderKey??"moyasar"}],rowCount:1};
    }
    return {rows:[],rowCount:1};
  });
  const client={query,release:vi.fn()} as unknown as PostgresClient;
  const pool={connect:vi.fn(async()=>client),query} as unknown as PostgresPool;
  return {store:new PostgresPaymentAdjustmentSubmissionOutbox(pool,()=>new Date("2026-11-16T17:00:00.000Z")),calls,query,pool};
}

describe("Postgres payment adjustment submission outbox",()=>{
  it("claims only the configured provider queue with a lease and stable idempotency key",async()=>{
    const {store,pool}=fixture();
    const query=vi.mocked(pool.query);
    query.mockResolvedValueOnce({rows:[{
      id:"submission-1",tenant_id:"tenant-1",adjustment_id:"adjustment-1",provider_key:"moyasar",
      idempotency_key:"stable-refund-key-123",attempt_count:1,order_id:"order-1",
      customer_id:"customer-1",adjustment_direction:"refund",amount_minor:"2500",currency:"SAR"
    }],rowCount:1} as never);
    const job=await store.claimNext("worker-1","moyasar",60);
    expect(job).toMatchObject({
      submissionId:"submission-1",providerKey:"moyasar",idempotencyKey:"stable-refund-key-123",
      command:{orderId:"order-1",amountMinor:2500,direction:"refund",currency:"SAR",
        idempotencyKey:"stable-refund-key-123"}
    });
    expect(query.mock.calls[0]?.[1]).toEqual(["worker-1",60,"moyasar"]);
    expect(query.mock.calls[0]?.[0]).toContain("FOR UPDATE OF o SKIP LOCKED");
    expect(query.mock.calls[0]?.[0]).toContain("status='reconciliation_required'");
    expect(query.mock.calls[0]?.[0]).toContain("PAYMENT_ADJUSTMENT_LEASE_EXPIRED_REQUIRES_RECONCILIATION");
    expect(query.mock.calls[0]?.[0]).toContain("WHERE o.status='queued'");
    expect(query.mock.calls[0]?.[0]).toContain("FROM payment_refund_reservations AS r");
    expect(query.mock.calls[0]?.[0]).toContain("r.status='reserved'");
    expect(query.mock.calls[0]?.[0]).not.toContain("o.status='processing' AND o.lease_expires_at <= now()");
  });

  it("records provider acceptance and adjustment event in one transaction",async()=>{
    const {store,calls}=fixture();
    await expect(store.recordAccepted({
      submissionId:"submission-1",workerId:"worker-1",providerReference:"refund-ref-123",
      actorId:"payment-adjustment-worker"
    })).resolves.toBe("submitted");
    expect(calls.some(c=>c.sql.includes("SET provider_reference=$3"))).toBe(true);
    expect(calls.some(c=>c.sql.includes("'provider_submitted'"))).toBe(true);
    expect(calls.some(c=>c.sql.includes("SET status='submitted'"))).toBe(true);
    expect(calls.some(c=>c.sql==="COMMIT")).toBe(true);
    expect(calls.some(c=>c.sql==="ROLLBACK")).toBe(false);
  });

  it("does not persist provider acceptance after its lease expires",async()=>{
    const {store,calls}=fixture({leaseValid:false});
    await expect(store.recordAccepted({
      submissionId:"submission-1",workerId:"worker-1",providerReference:"refund-ref-123",
      actorId:"payment-adjustment-worker"
    })).resolves.toBe("lease_lost");
    expect(calls.some(c=>c.sql.includes("SET provider_reference=$3"))).toBe(false);
    expect(calls.some(c=>c.sql==="ROLLBACK")).toBe(true);
  });

  it("moves ambiguous provider outcomes to reconciliation without requeueing",async()=>{
    const {store,pool}=fixture();
    const query=vi.mocked(pool.query);
    query.mockResolvedValueOnce({rows:[],rowCount:1} as never);
    await expect(store.recordUnknown({
      submissionId:"submission-1",workerId:"worker-1",
      failureCode:"PAYMENT_PROVIDER_OUTCOME_UNKNOWN"
    })).resolves.toBe("reconciliation_required");
    expect(query.mock.calls[0]?.[0]).toContain("status='reconciliation_required'");
    expect(query.mock.calls[0]?.[0]).toContain("lease_owner=NULL");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "submission-1","worker-1","PAYMENT_PROVIDER_OUTCOME_UNKNOWN"
    ]);
  });

  it("reschedules transient provider errors using the same durable submission",async()=>{
    const {store,calls}=fixture();
    const query=vi.mocked((store as unknown as {pool:PostgresPool}).pool.query);
    query.mockResolvedValueOnce({rows:[{attempt_count:2,status:"queued"}],rowCount:1} as never);
    await expect(store.retry({
      submissionId:"submission-1",workerId:"worker-1",
      failureCode:"PAYMENT_PROVIDER_TEMPORARY_FAILURE",delaySeconds:30
    })).resolves.toBe("rescheduled");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "submission-1","worker-1",30,"PAYMENT_PROVIDER_TEMPORARY_FAILURE"
    ]);
  });
});
