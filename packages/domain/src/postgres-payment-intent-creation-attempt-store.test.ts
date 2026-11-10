import {describe,expect,it,vi} from "vitest";
import type {PostgresPool} from "./postgres-iam-store.js";
import {PostgresPaymentIntentCreationAttemptStore} from "./postgres-payment-intent-creation-attempt-store.js";
const input={tenantId:"tenant-1",orderId:"order-1",providerKey:"moyasar",idempotencyKey:"checkout-intent-001",amountMinor:12500,currency:"SAR"};
describe("durable payment-intent creation attempts",()=>{
 it("reserves a dispatch attempt before calling the provider",async()=>{
  const query=vi.fn(async()=>({rows:[{id:"attempt-1"}],rowCount:1}));
  const store=new PostgresPaymentIntentCreationAttemptStore({query,connect:vi.fn()} as unknown as PostgresPool,()=>"attempt-1");
  await expect(store.begin(input)).resolves.toEqual({outcome:"dispatch",attemptId:"attempt-1"});
 });
 it("recognizes exact idempotent replay without a second dispatch",async()=>{
  const query=vi.fn(async(sql:string)=>sql.includes("INSERT")?{rows:[],rowCount:0}:{rows:[{
   id:"attempt-1",tenant_id:"tenant-1",order_id:"order-1",provider_key:"moyasar",idempotency_key:"checkout-intent-001",
   amount_minor:12500,currency:"SAR",status:"outcome_unknown",provider_payment_reference:null,expires_at:null}],rowCount:1});
  const store=new PostgresPaymentIntentCreationAttemptStore({query,connect:vi.fn()} as unknown as PostgresPool);
  await expect(store.begin(input)).resolves.toEqual({outcome:"duplicate",attemptId:"attempt-1",status:"outcome_unknown"});
 });
 it("fails closed when an idempotency key is reused for a different order",async()=>{
  const query=vi.fn(async(sql:string)=>sql.includes("INSERT")?{rows:[],rowCount:0}:{rows:[{
   id:"attempt-1",tenant_id:"tenant-1",order_id:"other-order",provider_key:"moyasar",idempotency_key:"checkout-intent-001",
   amount_minor:12500,currency:"SAR",status:"dispatching",provider_payment_reference:null,expires_at:null}],rowCount:1});
  const store=new PostgresPaymentIntentCreationAttemptStore({query,connect:vi.fn()} as unknown as PostgresPool);
  await expect(store.begin(input)).resolves.toEqual({outcome:"identity_collision"});
 });
 it("blocks a new key while the same order has an unresolved attempt",async()=>{
  const query=vi.fn(async(sql:string)=>sql.includes("INSERT")?{rows:[],rowCount:0}:{rows:[{
   id:"attempt-1",tenant_id:"tenant-1",order_id:"order-1",provider_key:"moyasar",idempotency_key:"older-attempt-001",
   amount_minor:12500,currency:"SAR",status:"outcome_unknown",provider_payment_reference:null,expires_at:null}],rowCount:1});
  const store=new PostgresPaymentIntentCreationAttemptStore({query,connect:vi.fn()} as unknown as PostgresPool);
  await expect(store.begin({...input,idempotencyKey:"checkout-intent-002"}))
   .resolves.toEqual({outcome:"order_attempt_exists",attemptId:"attempt-1",status:"outcome_unknown"});
 });
 it("records provider-confirmed absence only with a reconciliation reference",async()=>{
  const query=vi.fn(async()=>({rows:[{id:"attempt-1"}],rowCount:1}));
  const store=new PostgresPaymentIntentCreationAttemptStore({query,connect:vi.fn()} as unknown as PostgresPool);
  await expect(store.markOutcomeUnknown("attempt-1")).resolves.toBe("updated");
  await store.markReconciledRejected({attemptId:"attempt-1",failureCode:"PROVIDER_CONFIRMED_ABSENT",providerReconciliationReference:"reconciliation-123"});
  expect(query.mock.calls[1]?.[0]).toContain("provider_reconciliation_reference");
 });
 it("validates input before database access",async()=>{
  const query=vi.fn(async()=>({rows:[],rowCount:0}));
  const store=new PostgresPaymentIntentCreationAttemptStore({query,connect:vi.fn()} as unknown as PostgresPool);
  await expect(store.begin({...input,amountMinor:0})).rejects.toThrow("INVALID_PAYMENT_INTENT_ATTEMPT");
  expect(query).not.toHaveBeenCalled();
 });
});
