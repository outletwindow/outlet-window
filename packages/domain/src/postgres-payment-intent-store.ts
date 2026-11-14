import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";
import type { ExpectedPaymentOrder, PaymentCaptureOrderResolver } from "./verified-order-payment-capture-webhook.js";

export type PaymentIntentWriteResult =
  | { outcome: "created"; intentId: string }
  | { outcome: "duplicate"; intentId: string }
  | { outcome: "identity_collision" };

export class PostgresPaymentIntentStore implements PaymentCaptureOrderResolver {
  constructor(private readonly pool: PostgresPool, private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date()) {}

  async recordCreatedIntent(input: {
    tenantId: string; orderId: string; providerKey: string; providerPaymentReference: string;
    amountMinor: number; currency: string; idempotencyKey: string; expiresAtUtc: string;
  }): Promise<PaymentIntentWriteResult> {
    const expiry = Date.parse(input.expiresAtUtc);
    const now = this.now().getTime();
    if (!input.tenantId.trim() || !input.orderId.trim() ||
      !/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey) ||
      !input.providerPaymentReference.trim() || input.providerPaymentReference.length > 240 ||
      !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 ||
      !/^[A-Z]{3}$/.test(input.currency) ||
      !/^[a-zA-Z0-9._:-]{8,240}$/.test(input.idempotencyKey) ||
      !Number.isFinite(expiry) || expiry <= now || expiry > now + 24 * 60 * 60_000) {
      throw new Error("INVALID_PROVIDER_PAYMENT_INTENT");
    }
    const id = this.createId();
    const inserted = await this.pool.query<{id:string}>(
      `INSERT INTO provider_payment_intents
       (id,tenant_id,order_id,provider_key,provider_payment_reference,amount_minor,currency,idempotency_key,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
      [id,input.tenantId,input.orderId,input.providerKey,input.providerPaymentReference,
        input.amountMinor,input.currency,input.idempotencyKey,input.expiresAtUtc]
    );
    if (inserted.rowCount === 1) return {outcome:"created",intentId:inserted.rows[0]!.id};
    const existing = await this.pool.query<{
      id:string;tenant_id:string;order_id:string;provider_key:string;provider_payment_reference:string;
      amount_minor:string|number;currency:string;idempotency_key:string;expires_at:Date|string;
    }>(
      `SELECT id,tenant_id,order_id,provider_key,provider_payment_reference,amount_minor,currency,idempotency_key,expires_at
       FROM provider_payment_intents
       WHERE (provider_key=$1 AND provider_payment_reference=$2) OR (tenant_id=$3 AND idempotency_key=$4)
       ORDER BY created_at`,
      [input.providerKey,input.providerPaymentReference,input.tenantId,input.idempotencyKey]
    );
    if (existing.rowCount !== 1) return {outcome:"identity_collision"};
    const row=existing.rows[0]!;
    const same=row.tenant_id===input.tenantId && row.order_id===input.orderId &&
      row.provider_key===input.providerKey && row.provider_payment_reference===input.providerPaymentReference &&
      Number(row.amount_minor)===input.amountMinor && row.currency===input.currency &&
      row.idempotency_key===input.idempotencyKey &&
      new Date(row.expires_at).toISOString()===new Date(input.expiresAtUtc).toISOString();
    return same ? {outcome:"duplicate",intentId:row.id} : {outcome:"identity_collision"};
  }

  /**
   * Resolve a provider-confirmed capture even when webhook delivery is delayed
   * beyond the payment-intent fulfillment deadline. Expiry prevents starting
   * a new payment; it must not discard evidence that the provider already
   * collected the exact amount for this still-payable order.
   */
  async findExpectedOrder(input: {
    providerKey:string; providerPaymentReference:string; amountMinor:number; currency:string;
  }): Promise<ExpectedPaymentOrder|null> {
    const result=await this.pool.query<{tenant_id:string;order_id:string;id:string}>(
      `SELECT i.id,i.tenant_id,i.order_id
       FROM provider_payment_intents i
       JOIN customer_orders o ON o.tenant_id=i.tenant_id AND o.id=i.order_id
       WHERE i.provider_key=$1 AND i.provider_payment_reference=$2
         AND i.amount_minor=$3 AND i.currency=$4
         AND o.status='awaiting_payment'`,
      [input.providerKey,input.providerPaymentReference,input.amountMinor,input.currency]
    );
    return result.rowCount===1 ? {tenantId:result.rows[0]!.tenant_id,orderId:result.rows[0]!.order_id,paymentIntentId:result.rows[0]!.id} : null;
  }
}
