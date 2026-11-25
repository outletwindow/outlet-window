import { timingSafeEqual } from "node:crypto";
import type {
  MerchantPayoutConfirmationEvent,
  MerchantPayoutConfirmationEventDecoder,
  MerchantPayoutWebhookVerifier
} from "./merchant-payout-confirmation-webhook.js";

type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUniqueHeader(headers: Readonly<Record<string, string>>, name: string): string | null {
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  if (matches.length !== 1) return null;
  const value = matches[0]![1];
  return value && !value.includes(",") ? value : null;
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Moyasar platform merchant webhooks use a shared secret token, not an HMAC.
 * Header names are read case-insensitively; duplicate/combined security headers fail closed.
 */
export function createMoyasarMerchantPayoutWebhookVerifier(
  expectedLiveMode: boolean
): MerchantPayoutWebhookVerifier {
  return {
    verify({ rawBody, headers, secret }) {
      if (!rawBody || Buffer.byteLength(rawBody, "utf8") > 65_536 ||
          !secret || secret.length > 4096) return false;
      let parsed: unknown;
      try { parsed = JSON.parse(rawBody) as unknown; } catch { return false; }
      if (!isRecord(parsed) ||
          typeof parsed.id !== "string" || !parsed.id.trim() ||
          typeof parsed.type !== "string" || !parsed.type.trim() ||
          typeof parsed.secret_token !== "string" || !parsed.secret_token ||
          typeof parsed.created_at !== "string" || !Number.isFinite(Date.parse(parsed.created_at)) ||
          typeof parsed.account_name !== "string" || !parsed.account_name.trim() ||
          typeof parsed.live !== "boolean" || parsed.live !== expectedLiveMode ||
          typeof parsed.merchant_id !== "string" || !parsed.merchant_id.trim() ||
          typeof parsed.entity_id !== "string" || !parsed.entity_id.trim() ||
          !isRecord(parsed.data)) return false;

      const eventId = readUniqueHeader(headers, "x-event-id");
      const eventType = readUniqueHeader(headers, "x-event-type");
      const headerSecret = readUniqueHeader(headers, "x-event-secret");
      if (!eventId || !eventType || !headerSecret ||
          eventId !== parsed.id || eventType !== parsed.type) return false;

      return constantTimeTextEqual(parsed.secret_token, secret) &&
        constantTimeTextEqual(headerSecret, secret);
    }
  };
}

/** Only the terminal paid event can enter the payout-confirmation journal path. */
export const moyasarMerchantPayoutConfirmationEventDecoder: MerchantPayoutConfirmationEventDecoder = {
  decode(rawBody: string): MerchantPayoutConfirmationEvent | null {
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody) as unknown; } catch { return null; }
    if (!isRecord(parsed) || parsed.type !== "merchant_payout_paid" ||
        typeof parsed.id !== "string" ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(parsed.id) ||
        typeof parsed.merchant_id !== "string" ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(parsed.merchant_id) ||
        typeof parsed.entity_id !== "string" ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(parsed.entity_id) ||
        typeof parsed.created_at !== "string" ||
        !Number.isFinite(Date.parse(parsed.created_at)) ||
        typeof parsed.live !== "boolean" || !isRecord(parsed.data)) return null;

    const payout = parsed.data;
    if (payout.status !== "paid" ||
        typeof payout.id !== "string" ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(payout.id) ||
        !Number.isSafeInteger(payout.amount) || (payout.amount as number) <= 0 ||
        typeof payout.currency !== "string" || !/^[A-Z]{3}$/.test(payout.currency) ||
        !isRecord(payout.metadata) ||
        typeof payout.metadata.outlet_window_outbox_id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(payout.metadata.outlet_window_outbox_id)) return null;

    return {
      providerEventId: parsed.id,
      outboxId: payout.metadata.outlet_window_outbox_id,
      providerReference: payout.id,
      amountMinor: payout.amount as number,
      currency: payout.currency,
      merchantId: parsed.merchant_id,
      entityId: parsed.entity_id
    };
  }
};


import {
  MerchantPayoutConfirmationWebhookProcessor,
  type VerifiedMerchantPayoutConfirmationStore
} from "./merchant-payout-confirmation-webhook.js";

/** Concrete composition for the documented Moyasar platform merchant-payout event contract. */
export class MoyasarMerchantPayoutConfirmationWebhookProcessor {
  private readonly processor: MerchantPayoutConfirmationWebhookProcessor;

  constructor(dependencies: {
    secretResolver: (providerKey: string) => Promise<string | null>;
    store: VerifiedMerchantPayoutConfirmationStore;
    auditActorId: string;
    expectedLiveMode: boolean;
  }) {
    this.processor = new MerchantPayoutConfirmationWebhookProcessor({
      secretResolver: dependencies.secretResolver,
      verifier: createMoyasarMerchantPayoutWebhookVerifier(dependencies.expectedLiveMode),
      decoder: moyasarMerchantPayoutConfirmationEventDecoder,
      store: dependencies.store,
      auditActorId: dependencies.auditActorId
    });
  }

  process(input: {
    rawBody: string;
    headers: Readonly<Record<string, string>>;
  }) {
    return this.processor.process({
      providerKey: "moyasar",
      rawBody: input.rawBody,
      headers: input.headers
    });
  }
}
