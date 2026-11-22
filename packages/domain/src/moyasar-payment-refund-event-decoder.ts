export interface DecodedMoyasarRefundEvent {
  providerEventId: string;
  providerPaymentReference: string;
  refundedMinor: number;
  refundableBaseMinor: number;
  currency: string;
  refundedAtUtc: string;
  live: boolean;
}

type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decodes only Moyasar's payment_refunded notification.
 * The event carries the payment snapshot and cumulative refunded amount, not
 * a unique refund-operation identifier. Callers must match it to the single
 * active local reservation by original payment reference and verify the
 * cumulative amount before applying any ledger transition.
 */
export const moyasarPaymentRefundEventDecoder = {
  decode(rawBody: string): DecodedMoyasarRefundEvent | null {
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody) as unknown; } catch { return null; }
    if (!isRecord(parsed) || parsed.type !== "payment_refunded" ||
        typeof parsed.id !== "string" ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(parsed.id) ||
        typeof parsed.created_at !== "string" ||
        !Number.isFinite(Date.parse(parsed.created_at)) ||
        typeof parsed.live !== "boolean" || !isRecord(parsed.data)) return null;

    const payment = parsed.data;
    if (typeof payment.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payment.id) ||
        payment.status !== "refunded" ||
        !Number.isSafeInteger(payment.amount) || (payment.amount as number) <= 0 ||
        !Number.isSafeInteger(payment.captured) || (payment.captured as number) < 0 ||
        (payment.captured as number) > (payment.amount as number) ||
        !Number.isSafeInteger(payment.refunded) || (payment.refunded as number) <= 0 ||
        typeof payment.currency !== "string" || !/^[A-Z]{3}$/.test(payment.currency)) return null;

    const refundableBaseMinor = (payment.captured as number) > 0
      ? payment.captured as number
      : payment.amount as number;
    if ((payment.refunded as number) > refundableBaseMinor) return null;

    const refundedAt = typeof payment.refunded_at === "string" &&
      Number.isFinite(Date.parse(payment.refunded_at))
      ? payment.refunded_at
      : parsed.created_at;

    return {
      providerEventId: parsed.id,
      providerPaymentReference: payment.id,
      refundedMinor: payment.refunded as number,
      refundableBaseMinor,
      currency: payment.currency,
      refundedAtUtc: new Date(refundedAt).toISOString(),
      live: parsed.live
    };
  }
};
