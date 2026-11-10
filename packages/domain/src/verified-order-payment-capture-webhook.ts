import { verifyPaymentProviderWebhook } from "./payment-adjustment-provider.js";
import type {
  PostgresVerifiedOrderPaymentCaptureStore,
  VerifiedCaptureWriteResult
} from "./postgres-verified-order-payment-capture.js";

export interface DecodedProviderCapture {
  providerEventId: string;
  providerPaymentReference: string;
  amountMinor: number;
  currency: string;
  capturedAtUtc: string;
}

export interface PaymentCaptureEventDecoder {
  /** Provider-specific parser; must reject non-capture events and untrusted/missing fields. */
  decodeCapture(rawBody: string): DecodedProviderCapture | null;
}

export interface PaymentCaptureWebhookVerifier {
  /** Verifies the provider's own authentication scheme against the exact raw body. */
  verify(input: {
    rawBody: string;
    signatureHeader?: string;
    secret: string;
    nowUtc?: Date;
  }): boolean;
}

export interface ExpectedPaymentOrder {
  tenantId: string;
  orderId: string;
  paymentIntentId: string;
}

export interface PaymentCaptureOrderResolver {
  /** Resolve from a server-created provider payment intent/reference, never from webhook metadata. */
  findExpectedOrder(input: {
    providerKey: string;
    providerPaymentReference: string;
    amountMinor: number;
    currency: string;
  }): Promise<ExpectedPaymentOrder | null>;
}

export type PaymentCaptureWebhookResult =
  | { outcome: "recorded"; captureId: string }
  | { outcome: "duplicate"; captureId: string }
  | { outcome: "identity_collision" }
  | { outcome: "invalid_signature_or_event" }
  | { outcome: "provider_not_configured" }
  | { outcome: "payment_intent_not_found" };

export class VerifiedOrderPaymentCaptureWebhookProcessor {
  constructor(private readonly dependencies: {
    secretResolver: (providerKey: string) => Promise<string | null>;
    decoders: ReadonlyMap<string, PaymentCaptureEventDecoder>;
    webhookVerifiers?: ReadonlyMap<string, PaymentCaptureWebhookVerifier>;
    orderResolver: PaymentCaptureOrderResolver;
    captureStore: Pick<PostgresVerifiedOrderPaymentCaptureStore, "recordVerifiedCapture">;
    inboxStore?: { recordVerified(input: { providerKey:string; providerEventId:string; paymentIntentId:string; rawBody:string; providerPaymentReference:string; amountMinor:number; currency:string; capturedAtUtc:string }): Promise<{outcome:"received"|"duplicate";receiptId:string}|{outcome:"event_id_collision"}> };
    now?: () => Date;
  }) {}

  async process(input: {
    providerKey: string;
    rawBody: string;
    signatureHeader?: string;
  }): Promise<PaymentCaptureWebhookResult> {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey) ||
        !input.rawBody || input.rawBody.length > 65_536) {
      return { outcome: "invalid_signature_or_event" };
    }
    const decoder = this.dependencies.decoders.get(input.providerKey);
    if (!decoder) return { outcome: "provider_not_configured" };
    const secret = await this.dependencies.secretResolver(input.providerKey);
    if (!secret) return { outcome: "provider_not_configured" };
    const providerVerifier = this.dependencies.webhookVerifiers?.get(input.providerKey);
    const verified = providerVerifier
      ? providerVerifier.verify({
          rawBody: input.rawBody,
          ...(input.signatureHeader === undefined ? {} : { signatureHeader: input.signatureHeader }),
          secret,
          ...(this.dependencies.now === undefined ? {} : { nowUtc: this.dependencies.now() })
        })
      : verifyPaymentProviderWebhook({
          rawBody: input.rawBody,
          ...(input.signatureHeader === undefined ? {} : { signatureHeader: input.signatureHeader }),
          secret,
          ...(this.dependencies.now === undefined ? {} : { nowUtc: this.dependencies.now() })
        });
    if (!verified) return { outcome: "invalid_signature_or_event" };

    let decoded: DecodedProviderCapture | null;
    try { decoded = decoder.decodeCapture(input.rawBody); }
    catch { return { outcome: "invalid_signature_or_event" }; }
    if (!decoded ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(decoded.providerEventId) ||
        !decoded.providerPaymentReference.trim() || decoded.providerPaymentReference.length > 240 ||
        !Number.isSafeInteger(decoded.amountMinor) || decoded.amountMinor <= 0 ||
        !/^[A-Z]{3}$/.test(decoded.currency) ||
        !Number.isFinite(Date.parse(decoded.capturedAtUtc)) ||
        Date.parse(decoded.capturedAtUtc) > (this.dependencies.now?.() ?? new Date()).getTime() + 300_000) {
      return { outcome: "invalid_signature_or_event" };
    }

    const expectedOrder = await this.dependencies.orderResolver.findExpectedOrder({
      providerKey: input.providerKey,
      providerPaymentReference: decoded.providerPaymentReference,
      amountMinor: decoded.amountMinor,
      currency: decoded.currency
    });
    if (!expectedOrder) return { outcome: "payment_intent_not_found" };

    if (this.dependencies.inboxStore) {
      const receipt = await this.dependencies.inboxStore.recordVerified({
        providerKey: input.providerKey, providerEventId: decoded.providerEventId,
        paymentIntentId: expectedOrder.paymentIntentId, rawBody: input.rawBody,
        providerPaymentReference: decoded.providerPaymentReference, amountMinor: decoded.amountMinor,
        currency: decoded.currency, capturedAtUtc: new Date(decoded.capturedAtUtc).toISOString()
      });
      if (receipt.outcome === "event_id_collision") return { outcome: "identity_collision" };
      return receipt.outcome === "received"
        ? { outcome: "recorded", captureId: receipt.receiptId }
        : { outcome: "duplicate", captureId: receipt.receiptId };
    }
    const stored: VerifiedCaptureWriteResult = await this.dependencies.captureStore.recordVerifiedCapture({
      tenantId: expectedOrder.tenantId, orderId: expectedOrder.orderId, providerKey: input.providerKey,
      providerEventId: decoded.providerEventId, providerPaymentReference: decoded.providerPaymentReference,
      amountMinor: decoded.amountMinor, currency: decoded.currency,
      capturedAtUtc: new Date(decoded.capturedAtUtc).toISOString(),
      idempotencyKey: `payment-capture:${input.providerKey}:${decoded.providerEventId}`
    });
    if (stored.outcome === "identity_collision") return { outcome: "identity_collision" };
    return stored.outcome === "inserted" ? { outcome: "recorded", captureId: stored.captureId } :
      { outcome: "duplicate", captureId: stored.captureId };
  }
}
