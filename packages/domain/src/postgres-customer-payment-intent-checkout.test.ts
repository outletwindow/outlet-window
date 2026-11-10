import {describe,expect,it,vi} from "vitest";
import type {PostgresPool} from "./postgres-iam-store.js";
import {PostgresCustomerPaymentIntentCheckout} from "./postgres-customer-payment-intent-checkout.js";

describe("authenticated customer payment-intent checkout",()=>{
 const callbackUrl="https://app.outletwindow.com/payment/callback";

 const payableOrder={tenant_id:"tenant-1",status:"awaiting_payment",total_minor:"12500",currency:"SAR"};
 const intent={id:"8f4d1c3e-6a52-4f0b-9a1e-2c7b5d8e0f31",amount:12500,currency:"SAR",
  clientSecret:"pi_secret_7Kq2mXbN9vT4wPzR1sYcHdLjF6aGuE8oQ3iK5nB0xVtZrWyM",
  expiresAtUtc:"2026-11-10T22:30:00.000Z"};
 function transactionalPool(options:{failIntentInsert?:boolean;beginAttempt?:boolean}={}){
  const poolQuery=vi.fn(async(sql:string)=>{
   if(sql.includes("FROM customer_orders"))return {rows:[payableOrder],rowCount:1};
   if(sql.includes("INSERT INTO payment_intent_creation_attempts"))return options.beginAttempt===false
    ?{rows:[],rowCount:0}:{rows:[{id:"attempt-1"}],rowCount:1};
   if(sql.includes("SELECT id,tenant_id,order_id,provider_key,idempotency_key"))return {rows:[{
    id:"attempt-1",tenant_id:"tenant-1",order_id:"order-1",provider_key:"moyasar",
    idempotency_key:"checkout-key-0001",amount_minor:12500,currency:"SAR",status:"created",
    provider_payment_reference:"provider-intent-1",expires_at:new Date(intent.expiresAtUtc)
   }],rowCount:1};
   if(sql.includes("UPDATE payment_intent_creation_attempts"))return {rows:[{id:"attempt-1"}],rowCount:1};
   throw new Error("UNEXPECTED_POOL_QUERY");
  });
  const clientQuery=vi.fn(async(sql:string)=>{
   if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK")return {rows:[],rowCount:0};
   if(sql.includes("SELECT id,tenant_id,order_id,provider_key,idempotency_key"))return {rows:[{
    id:"attempt-1",tenant_id:"tenant-1",order_id:"order-1",provider_key:"moyasar",
    idempotency_key:"checkout-key-0001",amount_minor:12500,currency:"SAR",status:"dispatching",
    provider_payment_reference:null,expires_at:null
   }],rowCount:1};
   if(sql.includes("INSERT INTO provider_payment_intents")){
    if(options.failIntentInsert)throw new Error("database write failed");
    return {rows:[],rowCount:1};
   }
   if(sql.includes("UPDATE payment_intent_creation_attempts"))return {rows:[{id:"attempt-1"}],rowCount:1};
   throw new Error("UNEXPECTED_CLIENT_QUERY");
  });
  const client={query:clientQuery,release:vi.fn()};
  const pool={query:poolQuery,connect:vi.fn(async()=>client)};
  return {pool:pool as unknown as PostgresPool,poolQuery,clientQuery,client};
 }
 it("looks up the order using both order id and authenticated customer id",async()=>{
  const query=vi.fn(async()=>({rows:[],rowCount:0}));
  const provider={createIntent:vi.fn()};
  const checkout=new PostgresCustomerPaymentIntentCheckout({query,connect:vi.fn()} as unknown as PostgresPool,provider as never,callbackUrl);
  await expect(checkout.create({customerId:"customer-1",orderId:"order-1",idempotencyKey:"checkout-key-0001"}))
   .resolves.toEqual({outcome:"not_found"});
  expect(query).toHaveBeenCalledWith(
   "SELECT tenant_id,status,total_minor,currency FROM customer_orders WHERE id=$1 AND customer_id=$2",
   ["order-1","customer-1"]
  );
  expect(provider.createIntent).not.toHaveBeenCalled();
 });
 it("does not call the provider for an order that is not awaiting payment",async()=>{
  const query=vi.fn(async()=>({rows:[{tenant_id:"tenant-1",status:"confirmed",total_minor:"12500",currency:"SAR"}],rowCount:1}));
  const provider={createIntent:vi.fn()};
  const checkout=new PostgresCustomerPaymentIntentCheckout({query,connect:vi.fn()} as unknown as PostgresPool,provider as never,callbackUrl);
  await expect(checkout.create({customerId:"customer-1",orderId:"order-1",idempotencyKey:"checkout-key-0001"}))
   .resolves.toEqual({outcome:"order_not_payable"});
  expect(provider.createIntent).not.toHaveBeenCalled();
 });
 it("rejects an unsafe callback URL at composition time",()=>{
  const provider={createIntent:vi.fn()};
  expect(()=>new PostgresCustomerPaymentIntentCheckout({query:vi.fn(),connect:vi.fn()} as unknown as PostgresPool,provider as never,"http://untrusted.example/callback"))
   .toThrow("INVALID_PAYMENT_CALLBACK_URL");
 });

 it("creates and persists an intent using the amount and currency loaded from the owned order",async()=>{
  const db=transactionalPool();
  const provider={createIntent:vi.fn(async()=>intent)};
  const checkout=new PostgresCustomerPaymentIntentCheckout(db.pool,provider,callbackUrl);
  await expect(checkout.create({customerId:"customer-1",orderId:"order-1",idempotencyKey:"checkout-key-0001"}))
   .resolves.toEqual({outcome:"created",providerPaymentReference:intent.id,clientSecret:intent.clientSecret,
    expiresAtUtc:intent.expiresAtUtc,amountMinor:12500,currency:"SAR"});
  expect(provider.createIntent).toHaveBeenCalledWith({amountMinor:12500,currency:"SAR",callbackUrl,
   description:"Outlet Window order order-1"});
  expect(db.clientQuery.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO provider_payment_intents"))).toBe(true);
  expect(db.client.release).toHaveBeenCalledOnce();
 });
 it("marks a provider rejection as rejected and returns a safe result",async()=>{
  const db=transactionalPool();
  const provider={createIntent:vi.fn().mockRejectedValue(new Error("MOYASAR_PAYMENT_INTENT_PROVIDER_REJECTED"))};
  const checkout=new PostgresCustomerPaymentIntentCheckout(db.pool,provider,callbackUrl);
  await expect(checkout.create({customerId:"customer-1",orderId:"order-1",idempotencyKey:"checkout-key-0001"}))
   .resolves.toEqual({outcome:"provider_rejected"});
  expect(db.poolQuery.mock.calls.some(([sql])=>String(sql).includes("SET status='rejected'"))).toBe(true);
  expect(db.poolQuery.mock.calls.some(([sql])=>String(sql).includes("SET status='outcome_unknown'"))).toBe(false);
 });
 it("keeps ambiguous provider outcomes unresolved without retrying",async()=>{
  const db=transactionalPool();
  const provider={createIntent:vi.fn().mockRejectedValue(new Error("MOYASAR_PAYMENT_INTENT_OUTCOME_UNKNOWN"))};
  const checkout=new PostgresCustomerPaymentIntentCheckout(db.pool,provider,callbackUrl);
  await expect(checkout.create({customerId:"customer-1",orderId:"order-1",idempotencyKey:"checkout-key-0001"}))
   .resolves.toEqual({outcome:"outcome_unknown"});
  expect(provider.createIntent).toHaveBeenCalledOnce();
  expect(db.poolQuery.mock.calls.some(([sql])=>String(sql).includes("SET status='outcome_unknown'"))).toBe(true);
 });
 it("does not dispatch again when an idempotency replay finds an existing intent",async()=>{
  const db=transactionalPool({beginAttempt:false});
  const provider={createIntent:vi.fn()};
  const checkout=new PostgresCustomerPaymentIntentCheckout(db.pool,provider,callbackUrl);
  await expect(checkout.create({customerId:"customer-1",orderId:"order-1",idempotencyKey:"checkout-key-0001"}))
   .resolves.toEqual({outcome:"attempt_exists"});
  expect(provider.createIntent).not.toHaveBeenCalled();
 });
 it("records an ambiguous persistence failure after provider success",async()=>{
  const db=transactionalPool({failIntentInsert:true});
  const provider={createIntent:vi.fn(async()=>intent)};
  const checkout=new PostgresCustomerPaymentIntentCheckout(db.pool,provider,callbackUrl);
  await expect(checkout.create({customerId:"customer-1",orderId:"order-1",idempotencyKey:"checkout-key-0001"}))
   .resolves.toEqual({outcome:"persistence_conflict"});
  expect(db.poolQuery.mock.calls.some(([sql])=>String(sql).includes("SET status='outcome_unknown'"))).toBe(true);
  expect(provider.createIntent).toHaveBeenCalledOnce();
 });
});
