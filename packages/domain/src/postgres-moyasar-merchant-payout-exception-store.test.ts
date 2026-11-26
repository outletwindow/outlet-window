import {describe,expect,it,vi} from "vitest";
import type {PostgresPool} from "./postgres-iam-store.js";
import {PostgresMoyasarMerchantPayoutExceptionStore} from "./postgres-moyasar-merchant-payout-exception-store.js";

const input={
  eventRowId:"event-row-1",caseId:"case-1",providerKey:"moyasar" as const,
  eventType:"payout_returned" as const,
  event:{providerEventId:"evt-returned-1",outboxId:"outbox-1",providerReference:"payout-ref-1",
    amountMinor:12500,currency:"SAR",merchantId:"provider-merchant-1",entityId:"provider-entity-1"}
};
function fixture(options:{identity?:boolean;duplicate?:boolean}={}){
  const calls:Array<{sql:string;values?:readonly unknown[]}>=[];
  const client={
    async query<Row>(sql:string,values?:readonly unknown[]){
      calls.push({sql,...(values===undefined?{}:{values})});
      if(sql.includes("SELECT o.tenant_id")) return {rows:options.identity===false?[]:[{tenant_id:"tenant-1"}] as Row[],rowCount:options.identity===false?0:1};
      if(sql.includes("FROM merchant_payout_provider_events")) return {rows:options.duplicate?[{
        outbox_id:input.event.outboxId,provider_reference:input.event.providerReference,
        amount_minor:input.event.amountMinor,currency:input.event.currency,
        event_type:input.eventType,signature_verified:true
      }] as Row[]:[],rowCount:options.duplicate?1:0};
      if(sql.includes("FROM merchant_payout_exception_cases")) return {rows:[{id:"case-original"}] as Row[],rowCount:1};
      if(sql.includes("record_verified_merchant_payout_exception")) return {rows:[{case_id:"case-1"}] as Row[],rowCount:1};
      return {rows:[] as Row[],rowCount:0};
    },release:vi.fn()
  };
  const pool={connect:async()=>client} as unknown as PostgresPool;
  return {store:new PostgresMoyasarMerchantPayoutExceptionStore(pool),calls,client};
}
describe("PostgresMoyasarMerchantPayoutExceptionStore",()=>{
  it("binds provider merchant/entity and records a verified returned case",async()=>{
    const f=fixture();
    await expect(f.store.recordVerified(input)).resolves.toEqual({outcome:"recorded",caseId:"case-1"});
    expect(f.calls[1]!.sql).toContain("provider_merchant_id=$2 AND e.provider_entity_id=$3");
    expect(f.calls[1]!.values).toEqual([
      input.event.outboxId,input.event.merchantId,input.event.entityId,input.event.providerReference,
      input.event.amountMinor,input.event.currency,input.eventType
    ]);
    expect(f.calls.some(c=>c.sql.includes("record_verified_merchant_payout_exception"))).toBe(true);
    expect(f.calls.some(c=>c.sql==="COMMIT")).toBe(true);
  });
  it("returns the existing case for a duplicate verified event",async()=>{
    const f=fixture({duplicate:true});
    await expect(f.store.recordVerified(input)).resolves.toEqual({outcome:"duplicate",caseId:"case-original"});
    expect(f.calls.some(c=>c.sql.includes("record_verified_merchant_payout_exception"))).toBe(false);
  });
  it("fails closed when provider identity/state does not match",async()=>{
    const f=fixture({identity:false});
    await expect(f.store.recordVerified(input)).rejects.toThrow("MOYASAR_PAYOUT_EXCEPTION_IDENTITY_OR_STATE_MISMATCH");
    expect(f.calls.some(c=>c.sql.includes("record_verified_merchant_payout_exception"))).toBe(false);
    expect(f.calls.some(c=>c.sql==="ROLLBACK")).toBe(true);
  });
});
