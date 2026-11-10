import type {
  DecodedProviderCapture,
  PaymentCaptureEventDecoder
} from "./verified-order-payment-capture-webhook.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Maps only Moyasar's payment_captured webhook into immutable capture evidence.
 * The event's captured amount (not the original authorized amount) is used so
 * partial captures are represented accurately.
 */
export const moyasarPaymentCaptureDecoder: PaymentCaptureEventDecoder = {
  decodeCapture(rawBody: string): DecodedProviderCapture | null {
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody) as unknown; } catch { return null; }
    if (!isRecord(parsed) || parsed.type !== "payment_captured" ||
        typeof parsed.id !== "string" || !parsed.id.trim() ||
        typeof parsed.created_at !== "string" ||
        !Number.isFinite(Date.parse(parsed.created_at)) ||
        typeof parsed.live !== "boolean" || !isRecord(parsed.data)) return null;

    const payment = parsed.data;
    if (typeof payment.id !== "string" || !payment.id.trim() ||
        payment.status !== "captured" ||
        !Number.isSafeInteger(payment.captured) || (payment.captured as number) <= 0 ||
        typeof payment.currency !== "string" || !/^[A-Z]{3}$/.test(payment.currency) ||
        typeof payment.captured_at !== "string" ||
        !Number.isFinite(Date.parse(payment.captured_at))) return null;

    return {
      providerEventId: parsed.id,
      providerPaymentReference: payment.id,
      amountMinor: payment.captured as number,
      currency: payment.currency,
      capturedAtUtc: new Date(payment.captured_at).toISOString()
    };
  }
};
