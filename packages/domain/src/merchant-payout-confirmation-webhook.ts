import { randomUUID } from "node:crypto";

/** Provider-specific verification must validate the raw bytes before decoding. */
export interface MerchantPayoutWebhookVerifier {
  verify(input: { rawBody: string; secret: string }): boolean | Promise<boolean>;
}

export interface MerchantPayoutConfirmationEvent {
  providerEventId: string;
  outboxId: string;
  providerReference: string;
  amountMinor: number;
  currency: string;
}

export interface MerchantPayoutConfirmationEventDecoder {
  decode(rawBody: string): MerchantPayoutConfirmationEvent | null;
}

export interface VerifiedMerchantPayoutConfirmationStore {
  confirmVerified(input: {
    eventRowId: string;
    auditActorId: string;
    providerKey: string;
    providerEventId: string;
    outboxId: string;
    providerReference: string;
    amountMinor: number;
    currency: string;
  }): Promise<{ outcome: "confirmed" | "duplicate"; journalId: string }>;
}

export type MerchantPayoutConfirmationWebhookResult =
  | { outcome: "confirmed" | "duplicate"; journalId: string }
  | { outcome: "invalid_signature_or_event" | "provider_not_configured" };

/**
 * Shared security boundary for payout-confirmation webhooks.
 *
 * Provider adapters supply their documented signature verifier and event decoder.
 * The processor never accepts a caller-provided signatureVerified flag. It verifies
 * the untouched body first, validates the normalized event, then invokes the
 * persistence primitive that atomically writes the provider event and journal.
 */
export class MerchantPayoutConfirmationWebhookProcessor {
  constructor(private readonly dependencies: {
    secretResolver: (providerKey: string) => Promise<string | null>;
    verifier: MerchantPayoutWebhookVerifier;
    decoder: MerchantPayoutConfirmationEventDecoder;
    store: VerifiedMerchantPayoutConfirmationStore;
    auditActorId: string;
  }) {
    if (!dependencies.auditActorId.trim() || dependencies.auditActorId.length > 160) {
      throw new Error("INVALID_PAYOUT_WEBHOOK_AUDIT_ACTOR");
    }
  }

  async process(input: { providerKey: string; rawBody: string }): Promise<MerchantPayoutConfirmationWebhookResult> {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey) ||
        !input.rawBody || Buffer.byteLength(input.rawBody, "utf8") > 65_536) {
      return { outcome: "invalid_signature_or_event" };
    }

    const secret = await this.dependencies.secretResolver(input.providerKey);
    if (!secret) return { outcome: "provider_not_configured" };

    let verified = false;
    try {
      verified = await this.dependencies.verifier.verify({ rawBody: input.rawBody, secret });
    } catch {
      return { outcome: "invalid_signature_or_event" };
    }
    if (!verified) return { outcome: "invalid_signature_or_event" };

    let event: MerchantPayoutConfirmationEvent | null;
    try {
      event = this.dependencies.decoder.decode(input.rawBody);
    } catch {
      return { outcome: "invalid_signature_or_event" };
    }
    if (!event || !/^[a-zA-Z0-9._:-]{1,240}$/.test(event.providerEventId) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(event.outboxId) ||
        !event.providerReference.trim() || event.providerReference.length > 240 ||
        !Number.isSafeInteger(event.amountMinor) || event.amountMinor <= 0 ||
        !/^[A-Z]{3}$/.test(event.currency)) {
      return { outcome: "invalid_signature_or_event" };
    }

    return this.dependencies.store.confirmVerified({
      eventRowId: randomUUID(),
      auditActorId: this.dependencies.auditActorId,
      providerKey: input.providerKey,
      providerEventId: event.providerEventId,
      outboxId: event.outboxId,
      providerReference: event.providerReference,
      amountMinor: event.amountMinor,
      currency: event.currency
    });
  }
}
