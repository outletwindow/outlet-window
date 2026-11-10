import {describe,expect,it,vi} from "vitest";
import type {PostgresPool} from "./postgres-iam-store.js";
import {PostgresCustomerPaymentIntentCheckout} from "./postgres-customer-payment-intent-checkout.js";

describe("authenticated customer payment-intent checkout",()=>{
 const callbackUrl="https://app.outletwindow.com/payment/callback";
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
});
