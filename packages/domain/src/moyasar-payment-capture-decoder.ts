import type {
  DecodedProviderCapture,
  PaymentCaptureEventDecoder
} from "./verified-order-payment-capture-webhook.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Maps only Moyasar's successful money-collection events into immutable
 * capture evidence. Purchase payments use payment_paid; manual authorization
 * flows use payment_captured. Partial captures are rejected for full-order
 * checkout until partial-payment accounting is explicitly supported.
 */
export const moyasarPaymentCaptureDecoder: PaymentCaptureEventDecoder = {
  decodeCapture(rawBody: string): DecodedProviderCapture | null {
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody) as unknown; } catch { return null; }
    if (!isRecord(parsed) ||
        (parsed.type !== "payment_paid" && parsed.type !== "payment_captured") ||
        typeof parsed.id !== "string" || !parsed.id.trim() ||
        typeof parsed.created_at !== "string" ||
        !Number.isFinite(Date.parse(parsed.created_at)) ||
        typeof parsed.live !== "boolean" || !isRecord(parsed.data)) return null;

    const payment = parsed.data;
    if (typeof payment.id !== "string" || !payment.id.trim() ||
        !Number.isSafeInteger(payment.amount) || (payment.amount as number) <= 0 ||
        typeof payment.currency !== "string" || !/^[A-Z]{3}$/.test(payment.currency)) return null;

    if (parsed.type === "payment_paid") {
      if (payment.status !== "paid") return null;
      const capturedAt = typeof payment.updated_at === "string" &&
        Number.isFinite(Date.parse(payment.updated_at))
        ? payment.updated_at
        : parsed.created_at;
      return {
        providerEventId: parsed.id,
        providerPaymentReference: payment.id,
        amountMinor: payment.amount as number,
        currency: payment.currency,
        capturedAtUtc: new Date(capturedAt).toISOString()
      };
    }

    if (payment.status !== "captured" ||
        !Number.isSafeInteger(payment.captured) ||
        (payment.captured as number) <= 0 ||
        payment.captured !== payment.amount ||
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
