import type { PaymentCaptureWebhookVerifier } from "./verified-order-payment-capture-webhook.js";
import { moyasarPaymentRefundEventDecoder } from "./moyasar-payment-refund-event-decoder.js";
import type { PostgresPaymentWebhookInbox } from "./postgres-payment-webhook-inbox.js";

export type MoyasarPaymentRefundWebhookResult =
  | { outcome: "applied" | "ignored" | "reconciliation_required" | "duplicate" }
  | { outcome: "event_id_collision" | "invalid_signature_or_event" | "provider_not_configured" };

/** Verifies and atomically reconciles Moyasar's cumulative payment_refunded snapshots. */
export class MoyasarPaymentRefundWebhookProcessor {
  constructor(private readonly dependencies: {
    secretResolver: (providerKey: string) => Promise<string | null>;
    verifier: PaymentCaptureWebhookVerifier;
    inbox: Pick<PostgresPaymentWebhookInbox, "recordAndReconcileMoyasarRefund">;
  }) {}

  async process(input: { providerKey: string; rawBody: string }): Promise<MoyasarPaymentRefundWebhookResult> {
    if (input.providerKey !== "moyasar" || !input.rawBody ||
        Buffer.byteLength(input.rawBody, "utf8") > 65_536) {
      return { outcome: "invalid_signature_or_event" };
    }
    const secret = await this.dependencies.secretResolver(input.providerKey);
    if (!secret) return { outcome: "provider_not_configured" };
    if (!this.dependencies.verifier.verify({ rawBody: input.rawBody, secret })) {
      return { outcome: "invalid_signature_or_event" };
    }
    const event = moyasarPaymentRefundEventDecoder.decode(input.rawBody);
    if (!event) return { outcome: "invalid_signature_or_event" };
    const outcome = await this.dependencies.inbox.recordAndReconcileMoyasarRefund({
      providerEventId: event.providerEventId,
      rawBody: input.rawBody,
      providerPaymentReference: event.providerPaymentReference,
      refundedMinor: event.refundedMinor,
      refundableBaseMinor: event.refundableBaseMinor,
      currency: event.currency,
      refundedAtUtc: event.refundedAtUtc
    });
    return { outcome };
  }
}
