export type MoyasarPaymentStatus =
  | "initiated" | "paid" | "authorized" | "failed" | "refunded"
  | "captured" | "voided" | "verified" | "expired";

export interface MoyasarPaymentSnapshot {
  id: string;
  status: MoyasarPaymentStatus;
  amountMinor: number;
  capturedMinor: number;
  refundedMinor: number;
  currency: string;
}

export interface MoyasarPaymentReconciliationOptions {
  secretKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type MoyasarPaymentPayload = {
  id?: unknown;
  status?: unknown;
  amount?: unknown;
  captured?: unknown;
  refunded?: unknown;
  currency?: unknown;
};

/**
 * Read-only Moyasar payment lookup used to reconcile an uncertain refund.
 * This client never submits or retries a refund.
 */
export class MoyasarPaymentReconciliationClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: MoyasarPaymentReconciliationOptions) {
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(options.secretKey)) {
      throw new Error("INVALID_MOYASAR_SECRET_KEY");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new Error("INVALID_MOYASAR_TIMEOUT");
    }
  }

  async fetchPayment(paymentId: string): Promise<MoyasarPaymentSnapshot> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentId)) {
      throw new Error("INVALID_MOYASAR_PAYMENT_ID");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.moyasar.com/v1/payments/${encodeURIComponent(paymentId)}`, {
        method: "GET",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.options.secretKey}:`, "utf8").toString("base64")}`,
          accept: "application/json"
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new Error("MOYASAR_PAYMENT_RECONCILIATION_OUTCOME_UNKNOWN");
    }
    if (!response.ok) {
      if (response.status === 408 || response.status >= 500) {
        throw new Error("MOYASAR_PAYMENT_RECONCILIATION_OUTCOME_UNKNOWN");
      }
      throw new Error("MOYASAR_PAYMENT_RECONCILIATION_REJECTED");
    }
    let payload: MoyasarPaymentPayload;
    try {
      const raw = await response.text();
      if (raw.length > 32_768) throw new Error("oversized");
      payload = JSON.parse(raw) as MoyasarPaymentPayload;
    } catch {
      throw new Error("MOYASAR_PAYMENT_RECONCILIATION_INVALID_RESPONSE");
    }
    const statuses: readonly string[] = [
      "initiated", "paid", "authorized", "failed", "refunded",
      "captured", "voided", "verified", "expired"
    ];
    if (payload.id !== paymentId || typeof payload.status !== "string" ||
        !statuses.includes(payload.status) ||
        !Number.isSafeInteger(payload.amount) || (payload.amount as number) <= 0 ||
        !Number.isSafeInteger(payload.captured) || (payload.captured as number) < 0 ||
        !Number.isSafeInteger(payload.refunded) || (payload.refunded as number) < 0 ||
        (payload.refunded as number) > (payload.status === "paid" || (payload.status === "refunded" && payload.captured === 0) ? (payload.amount as number) : (payload.captured as number)) ||
        (payload.captured as number) > (payload.amount as number) ||
        typeof payload.currency !== "string" || !/^[A-Z]{3}$/.test(payload.currency)) {
      throw new Error("MOYASAR_PAYMENT_RECONCILIATION_INVALID_RESPONSE");
    }
    return {
      id: paymentId,
      status: payload.status as MoyasarPaymentStatus,
      amountMinor: payload.amount as number,
      capturedMinor: payload.captured as number,
      refundedMinor: payload.refunded as number,
      currency: payload.currency
    };
  }
}
