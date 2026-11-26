import type { MerchantPayoutConfirmationEvent, MerchantPayoutConfirmationEventDecoder } from "./merchant-payout-confirmation-webhook.js";

type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode only failed/canceled/returned payout events; paid remains on its journal path. */
export const moyasarMerchantPayoutExceptionEventDecoder: MerchantPayoutConfirmationEventDecoder = {
  decode(rawBody: string): MerchantPayoutConfirmationEvent | null {
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody) as unknown; } catch { return null; }
    if (!isRecord(parsed) ||
      !["merchant_payout_failed","merchant_payout_canceled","merchant_payout_returned"].includes(String(parsed.type)) ||
      typeof parsed.id !== "string" || !/^[a-zA-Z0-9._:-]{1,240}$/.test(parsed.id) ||
      typeof parsed.merchant_id !== "string" || !/^[a-zA-Z0-9._:-]{1,240}$/.test(parsed.merchant_id) ||
      typeof parsed.entity_id !== "string" || !/^[a-zA-Z0-9._:-]{1,240}$/.test(parsed.entity_id) ||
      typeof parsed.created_at !== "string" || !Number.isFinite(Date.parse(parsed.created_at)) ||
      typeof parsed.live !== "boolean" || !isRecord(parsed.data)) return null;

    const payout = parsed.data;
    const expectedStatus = parsed.type === "merchant_payout_returned" ? "returned" :
      parsed.type === "merchant_payout_canceled" ? "canceled" : "failed";
    if (payout.status !== expectedStatus ||
      typeof payout.id !== "string" || !/^[a-zA-Z0-9._:-]{1,240}$/.test(payout.id) ||
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
