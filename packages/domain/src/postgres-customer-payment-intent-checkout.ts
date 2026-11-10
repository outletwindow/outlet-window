import type { PostgresPool } from "./postgres-iam-store.js";
import { PostgresPaymentIntentCreationAttemptStore } from "./postgres-payment-intent-creation-attempt-store.js";
import type { MoyasarPaymentIntentClient } from "./moyasar-payment-intent-client.js";

export type CustomerPaymentIntentCheckoutResult =
 | { outcome:"created"; providerPaymentReference:string; clientSecret:string; expiresAtUtc:string; amountMinor:number; currency:string }
 | { outcome:"not_found"|"order_not_payable"|"attempt_exists"|"idempotency_conflict"|"outcome_unknown"|"provider_rejected"|"persistence_conflict" };

/** Authenticated server-side checkout. The callback URL is fixed by trusted server configuration. */
export class PostgresCustomerPaymentIntentCheckout {
 private readonly attempts:PostgresPaymentIntentCreationAttemptStore;
 constructor(private readonly pool:PostgresPool, private readonly provider:Pick<MoyasarPaymentIntentClient,"createIntent">, private readonly callbackUrl:string) {
  const callback=new URL(callbackUrl);
  if(callback.protocol!=="https:"||callback.username||callback.password) throw new Error("INVALID_PAYMENT_CALLBACK_URL");
  this.attempts=new PostgresPaymentIntentCreationAttemptStore(pool);
 }
 async create(input:{customerId:string;orderId:string;idempotencyKey:string}):Promise<CustomerPaymentIntentCheckoutResult>{
  if(!input.customerId.trim()||!input.orderId.trim()||!/^[a-zA-Z0-9._:-]{8,240}$/.test(input.idempotencyKey)) throw new Error("INVALID_CUSTOMER_PAYMENT_CHECKOUT");
  const found=await this.pool.query<{tenant_id:string;status:string;total_minor:string|number;currency:string}>(
   "SELECT tenant_id,status,total_minor,currency FROM customer_orders WHERE id=$1 AND customer_id=$2",[input.orderId,input.customerId]);
  if(found.rowCount!==1) return {outcome:"not_found"};
  const order=found.rows[0]!; const amountMinor=Number(order.total_minor); const currency=order.currency;
  if(order.status!=="awaiting_payment"||!Number.isSafeInteger(amountMinor)||amountMinor<100) return {outcome:"order_not_payable"};
  const attempt=await this.attempts.begin({tenantId:order.tenant_id,orderId:input.orderId,providerKey:"moyasar",idempotencyKey:input.idempotencyKey,amountMinor,currency});
  if(attempt.outcome==="identity_collision") return {outcome:"idempotency_conflict"};
  if(attempt.outcome!=="dispatch") return {outcome:"attempt_exists"};
  let intent;
  try { intent=await this.provider.createIntent({amountMinor,currency,callbackUrl:this.callbackUrl,description:"Outlet Window order "+input.orderId}); }
  catch(error) {
   if(error instanceof Error&&error.message==="MOYASAR_PAYMENT_INTENT_PROVIDER_REJECTED") {
    await this.attempts.markRejected({attemptId:attempt.attemptId,failureCode:"PROVIDER_REJECTED"}); return {outcome:"provider_rejected"};
   }
   await this.attempts.markOutcomeUnknown(attempt.attemptId); return {outcome:"outcome_unknown"};
  }
  const saved=await this.attempts.markCreated({attemptId:attempt.attemptId,providerPaymentReference:intent.id,expiresAtUtc:intent.expiresAtUtc});
  if(saved!=="created") return {outcome:"persistence_conflict"};
  return {outcome:"created",providerPaymentReference:intent.id,clientSecret:intent.clientSecret,expiresAtUtc:intent.expiresAtUtc,amountMinor,currency};
 }
}
