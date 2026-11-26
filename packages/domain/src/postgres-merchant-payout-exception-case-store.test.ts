import {describe,expect,it,vi} from "vitest";
import type {PostgresPool} from "./postgres-iam-store.js";
import {PostgresMerchantPayoutExceptionCaseStore} from "./postgres-merchant-payout-exception-case-store.js";
const row={
 id:"case-1",tenant_id:"tenant-1",outbox_id:"outbox-1",provider_key:"moyasar",
 provider_event_id:"evt-1",provider_reference:"payout-1",event_type:"payout_returned" as const,
 amount_minor:12500,currency:"SAR",review_status:"under_review" as const,
 review_started_by:"reviewer-1",review_started_at:"2026-11-26T10:00:00.000Z",
 resolution_code:null,resolution_note:null,resolved_by:null,resolved_at:null,
 created_at:"2026-11-26T09:00:00.000Z"
};
function fixture(options:{update?:boolean;existingStatus?:string;reviewer?:string|null}={}){
 const calls:Array<{sql:string;values?:readonly unknown[]}>=[];
 const client={
  async query<RowType>(sql:string,values?:readonly unknown[]){
   calls.push({sql,...(values===undefined?{}:{values})});
   if(sql.includes("UPDATE merchant_payout_exception_cases")&&options.update!==false)
    return {rows:[row] as RowType[],rowCount:1};
   if(sql.includes("SELECT review_status,review_started_by"))
    return {rows:options.existingStatus?[{review_status:options.existingStatus,review_started_by:options.reviewer??"reviewer-1"}] as RowType[]:[],rowCount:options.existingStatus?1:0};
   if(sql.includes("SELECT review_status FROM merchant_payout_exception_cases"))
    return {rows:options.existingStatus?[{review_status:options.existingStatus}] as RowType[]:[],rowCount:options.existingStatus?1:0};
   if(sql.includes("SELECT id,tenant_id"))
    return {rows:[row] as RowType[],rowCount:1};
   return {rows:[] as RowType[],rowCount:0};
  },release:vi.fn()
 };
 return {store:new PostgresMerchantPayoutExceptionCaseStore({connect:async()=>client,query:client.query} as unknown as PostgresPool),calls};
}
describe("PostgresMerchantPayoutExceptionCaseStore",()=>{
 it("lists cases using a bounded status filter",async()=>{
  const f=fixture();
  await expect(f.store.list({status:"under_review",limit:25})).resolves.toHaveLength(1);
  expect(f.calls[0]!.values).toEqual(["under_review",25]);
 });
 it("starts review with authenticated actor attribution",async()=>{
  const f=fixture();
  const result=await f.store.startReview({caseId:"case-1",actorId:"reviewer-1"});
  expect(result.outcome).toBe("started");
  expect(f.calls[0]!.sql).toContain("review_started_by=$2");
  expect(f.calls[0]!.values).toEqual(["case-1","reviewer-1"]);
 });
 it("requires a different actor to resolve the reviewed case",async()=>{
  const f=fixture({update:false,existingStatus:"under_review",reviewer:"reviewer-1"});
  await expect(f.store.resolve({caseId:"case-1",actorId:"reviewer-1",resolutionCode:"BANK_RETURN_CONFIRMED"}))
   .resolves.toEqual({outcome:"reviewer_cannot_resolve"});
  expect(f.calls[0]!.sql).toContain("review_started_by<>$2");
 });
 it("resolves an under-review case with a separate actor and explicit code",async()=>{
  const f=fixture();
  const result=await f.store.resolve({caseId:"case-1",actorId:"reviewer-2",resolutionCode:"BANK_RETURN_CONFIRMED"});
  expect(result.outcome).toBe("resolved");
  expect(f.calls[0]!.values).toEqual(["case-1","reviewer-2","BANK_RETURN_CONFIRMED",null]);
 });
});
