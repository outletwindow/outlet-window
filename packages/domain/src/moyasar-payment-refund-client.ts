import {
  MoyasarPaymentReconciliationClient,
  type MoyasarPaymentSnapshot
} from "./moyasar-payment-reconciliation-client.js";
import type { PaymentFetchLike } from "./payment-adjustment-provider.js";

export type MoyasarRefundResult =
  | { outcome: "confirmed"; payment: MoyasarPaymentSnapshot; refundedThisAttemptMinor: number }
  | { outcome: "unknown"; code: string }
  | { outcome: "rejected"; code: string };

export interface MoyasarPaymentRefundOptions {
  secretKey: string;
  fetchImpl?: PaymentFetchLike;
  timeoutMs?: number;
}

type RefundPayload = {
  id?: unknown;
  status?: unknown;
  amount?: unknown;
  captured?: unknown;
  refunded?: unknown;
  currency?: unknown;
};

const paymentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const paymentStatuses = ["initiated", "paid", "authorized", "failed", "refunded", "captured", "voided", "verified", "expired"] as const;

/**
 * One-shot Moyasar refund client.
 *
 * The caller must reserve/serialize refunds against the original payment in its
 * durable database before calling this client. Moyasar documents idempotency for
 * payment creation, not for the refund endpoint; this client deliberately sends
 * no Idempotency-Key header and never automatically repeats a refund request.
 */
export class MoyasarPaymentRefundClient {
  private readonly fetchImpl: PaymentFetchLike;
  private readonly timeoutMs: number;
  private readonly reconciliation: MoyasarPaymentReconciliationClient;

  constructor(private readonly options: MoyasarPaymentRefundOptions) {
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(options.secretKey)) {
      throw new Error("INVALID_MOYASAR_SECRET_KEY");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new Error("INVALID_MOYASAR_TIMEOUT");
    }
    this.reconciliation = new MoyasarPaymentReconciliationClient({
      secretKey: options.secretKey,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs
    });
  }

  async refund(input: {
    paymentId: string;
    amountMinor: number;
    currency: string;
    expectedRefundedMinor: number;
  }): Promise<MoyasarRefundResult> {
    if (!paymentIdPattern.test(input.paymentId) ||
        !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 ||
        !/^[A-Z]{3}$/.test(input.currency) ||
        !Number.isSafeInteger(input.expectedRefundedMinor) || input.expectedRefundedMinor < 0) {
      return { outcome: "rejected", code: "INVALID_MOYASAR_REFUND_COMMAND" };
    }

    let before: MoyasarPaymentSnapshot;
    try {
      before = await this.reconciliation.fetchPayment(input.paymentId);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      return code === "MOYASAR_PAYMENT_RECONCILIATION_REJECTED"
        ? { outcome: "rejected", code: "MOYASAR_PAYMENT_LOOKUP_REJECTED" }
        : { outcome: "unknown", code: "MOYASAR_PAYMENT_LOOKUP_OUTCOME_UNKNOWN" };
    }

    if (before.currency !== input.currency ||
        (before.status !== "paid" && before.status !== "captured") ||
        before.refundedMinor !== input.expectedRefundedMinor) {
      return { outcome: "rejected", code: "MOYASAR_REFUND_PRECONDITION_CONFLICT" };
    }
    const refundableBase = before.status === "paid" ? before.amountMinor : before.capturedMinor;
    const remaining = refundableBase - before.refundedMinor;
    if (!Number.isSafeInteger(remaining) || input.amountMinor > remaining) {
      return { outcome: "rejected", code: "MOYASAR_REFUND_EXCEEDS_REMAINING_AMOUNT" };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.moyasar.com/v1/payments/${encodeURIComponent(input.paymentId)}/refund`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${this.options.secretKey}:`, "utf8").toString("base64")}`,
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify({ amount: input.amountMinor }),
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs)
        }
      );
    } catch {
      return { outcome: "unknown", code: "MOYASAR_REFUND_OUTCOME_UNKNOWN" };
    }

    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
      return { outcome: "unknown", code: "MOYASAR_REFUND_OUTCOME_UNKNOWN" };
    }
    if (!response.ok) {
      return { outcome: "rejected", code: `MOYASAR_REFUND_HTTP_${response.status}` };
    }

    let payload: RefundPayload;
    try {
      const raw = await response.text();
      if (raw.length > 32_768) throw new Error("oversized");
      payload = JSON.parse(raw) as RefundPayload;
    } catch {
      return { outcome: "unknown", code: "MOYASAR_REFUND_RESPONSE_UNVERIFIABLE" };
    }

    if (payload.id !== input.paymentId ||
        // Moyasar documents that a successful full or partial refund moves the payment to `refunded`.
        payload.status !== "refunded" || !paymentStatuses.includes(payload.status) ||
        !Number.isSafeInteger(payload.amount) || payload.amount !== before.amountMinor ||
        !Number.isSafeInteger(payload.captured) || payload.captured !== before.capturedMinor ||
        !Number.isSafeInteger(payload.refunded) ||
        payload.refunded !== input.expectedRefundedMinor + input.amountMinor ||
        typeof payload.currency !== "string" || payload.currency !== input.currency) {
      return { outcome: "unknown", code: "MOYASAR_REFUND_RESPONSE_UNVERIFIABLE" };
    }

    const after: MoyasarPaymentSnapshot = {
      id: input.paymentId,
      status: payload.status as MoyasarPaymentSnapshot["status"],
      amountMinor: payload.amount as number,
      capturedMinor: payload.captured as number,
      refundedMinor: payload.refunded as number,
      currency: payload.currency
    };
    return { outcome: "confirmed", payment: after, refundedThisAttemptMinor: input.amountMinor };
  }
}
