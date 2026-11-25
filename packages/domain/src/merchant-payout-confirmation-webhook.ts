import { randomUUID } from "node:crypto";

/** Provider-specific verification must validate the untouched request body and signed headers. */
export interface MerchantPayoutWebhookVerifier {
  verify(input: {
    rawBody: string;
    headers: Readonly<Record<string, string>>;
    secret: string;
  }): boolean | Promise<boolean>;
}

export interface MerchantPayoutConfirmationEvent {
  providerEventId: string;
  outboxId: string;
  providerReference: string;
  amountMinor: number;
  currency: string;
  merchantId?: string;
  entityId?: string;
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
    merchantId?: string;
    entityId?: string;
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
 * the untouched body and signed headers first, validates the normalized event, then
 * invokes the persistence primitive that atomically writes the provider event/journal.
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

  async process(input: {
    providerKey: string;
    rawBody: string;
    headers: Readonly<Record<string, string>>;
  }): Promise<MerchantPayoutConfirmationWebhookResult> {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey) ||
        !input.rawBody || Buffer.byteLength(input.rawBody, "utf8") > 65_536 ||
        !input.headers || typeof input.headers !== "object" ||
        Object.keys(input.headers).length > 64 ||
        Object.entries(input.headers).some(([key, value]) =>
          !/^[a-zA-Z0-9-]{1,100}$/.test(key) || typeof value !== "string" || value.length > 8_192
        )) {
      return { outcome: "invalid_signature_or_event" };
    }

    let secret: string | null;
    try {
      secret = await this.dependencies.secretResolver(input.providerKey);
    } catch {
      // Fail closed if the vault/secret resolver is unavailable.
      return { outcome: "provider_not_configured" };
    }
    if (!secret) return { outcome: "provider_not_configured" };

    let verified = false;
    try {
      verified = await this.dependencies.verifier.verify({
        rawBody: input.rawBody,
        headers: input.headers,
        secret
      });
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
        typeof event.providerReference !== "string" || !event.providerReference.trim() ||
        event.providerReference.length > 240 ||
        !Number.isSafeInteger(event.amountMinor) || event.amountMinor <= 0 ||
        !/^[A-Z]{3}$/.test(event.currency) ||
        (event.merchantId !== undefined && !/^[a-zA-Z0-9._:-]{1,240}$/.test(event.merchantId)) ||
        (event.entityId !== undefined && !/^[a-zA-Z0-9._:-]{1,240}$/.test(event.entityId))) {
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
      currency: event.currency,
      ...(event.merchantId === undefined ? {} : { merchantId: event.merchantId }),
      ...(event.entityId === undefined ? {} : { entityId: event.entityId })
    });
  }
}
