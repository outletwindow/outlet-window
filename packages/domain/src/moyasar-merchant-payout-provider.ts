import { createHash } from "node:crypto";
import type { PaymentFetchLike } from "./payment-adjustment-provider.js";
import type {
  MerchantPayoutDestinationDetails,
  MerchantPayoutProvider,
  MerchantPayoutProviderResult
} from "./merchant-payout-submission-worker.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MoyasarMerchantPayoutClientOptions {
  secretKey: string;
  sourceId: string;
  sourceAccountType: "bank" | "wallet";
  expectedLiveMode: boolean;
  fetchImpl?: PaymentFetchLike;
  timeoutMs?: number;
}

/** Stable RFC 4122 v4-shaped idempotency key derived from the durable outbox key. */
export function moyasarGivenIdFromOutboxKey(outboxId: string, idempotencyKey: string): string {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(outboxId) || !idempotencyKey.trim() || idempotencyKey.length > 240) {
    throw new Error("INVALID_MOYASAR_PAYOUT_IDEMPOTENCY_KEY");
  }
  const bytes = createHash("sha256")
    .update("outlet-window:moyasar:payout:v1:", "utf8")
    .update(outboxId, "utf8")
    .update(":", "utf8")
    .update(idempotencyKey, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function normalizeDestination(destination: MerchantPayoutDestinationDetails):
  | { type: "bank"; iban: string; name: string; mobile: string; country: string; city: string }
  | { type: "wallet"; mobile: string }
  | null {
  if (destination.type === "bank") {
    const iban = destination.iban.replace(/\s/g, "").toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{13,32}$/.test(iban) ||
        !destination.name.trim() || destination.name.length > 160 ||
        !/^\+?[0-9 ()-]{7,24}$/.test(destination.mobile) ||
        !/^[A-Z]{2}$/.test(destination.country) ||
        !destination.city.trim() || destination.city.length > 100) return null;
    return {
      type: "bank", iban, name: destination.name.trim(),
      mobile: destination.mobile.replace(/[ ()-]/g, ""),
      country: destination.country, city: destination.city.trim()
    };
  }
  if (!/^\+?[0-9]{7,20}$/.test(destination.mobile)) return null;
  return { type: "wallet", mobile: destination.mobile };
}

type MoyasarPayoutPayload = {
  id?: unknown;
  source_id?: unknown;
  status?: unknown;
  amount?: unknown;
  currency?: unknown;
  metadata?: unknown;
};

export class MoyasarMerchantPayoutProvider implements MerchantPayoutProvider {
  private readonly fetchImpl: PaymentFetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: MoyasarMerchantPayoutClientOptions) {
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(options.secretKey) ||
        !uuidPattern.test(options.sourceId) ||
        (options.secretKey.startsWith("sk_live_") !== options.expectedLiveMode)) {
      throw new Error("INVALID_MOYASAR_PAYOUT_CONFIGURATION");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new Error("INVALID_MOYASAR_PAYOUT_TIMEOUT");
    }
  }

  async submit(input: {
    payoutId: string;
    outboxId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    destinationToken?: string;
    destination?: MerchantPayoutDestinationDetails;
  }): Promise<MerchantPayoutProviderResult> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.outboxId) ||
        !input.payoutId.trim() || input.payoutId.length > 200 ||
        !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 ||
        !/^[A-Z]{3}$/.test(input.currency) || !input.destination) {
      return { status: "rejected", code: "INVALID_MOYASAR_PAYOUT_COMMAND" };
    }
    const destination = normalizeDestination(input.destination);
    if (!destination || destination.type !== this.options.sourceAccountType) {
      return { status: "rejected", code: "MOYASAR_PAYOUT_DESTINATION_INVALID" };
    }

    let givenId: string;
    try { givenId = moyasarGivenIdFromOutboxKey(input.outboxId, input.idempotencyKey); }
    catch { return { status: "rejected", code: "INVALID_MOYASAR_PAYOUT_IDEMPOTENCY_KEY" }; }

    let response: Response;
    try {
      response = await this.fetchImpl("https://api.moyasar.com/v1/payouts", {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.options.secretKey}:`, "utf8").toString("base64")}`,
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          source_id: this.options.sourceId,
          given_id: givenId,
          amount: input.amountMinor,
          purpose: "payment_to_merchant",
          destination,
          metadata: {
            outlet_window_outbox_id: input.outboxId,
            outlet_window_payout_intent_id: input.payoutId
          }
        }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      // The provider may have accepted the request before the connection failed.
      return { status: "unknown", code: "MOYASAR_PAYOUT_OUTCOME_UNKNOWN" };
    }

    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
      return { status: "unknown", code: "MOYASAR_PAYOUT_OUTCOME_UNKNOWN" };
    }
    if (!response.ok) return { status: "rejected", code: `MOYASAR_PAYOUT_HTTP_${response.status}` };

    let payload: MoyasarPayoutPayload;
    try {
      const raw = await response.text();
      if (raw.length > 32_768) throw new Error("oversized");
      payload = JSON.parse(raw) as MoyasarPayoutPayload;
    } catch {
      return { status: "unknown", code: "MOYASAR_PAYOUT_RESPONSE_UNVERIFIABLE" };
    }

    if (payload.id !== givenId || payload.source_id !== this.options.sourceId ||
        payload.amount !== input.amountMinor || payload.currency !== input.currency ||
        typeof payload.metadata !== "object" || payload.metadata === null ||
        (payload.metadata as Record<string, unknown>).outlet_window_outbox_id !== input.outboxId) {
      return { status: "unknown", code: "MOYASAR_PAYOUT_RESPONSE_MISMATCH" };
    }

    if (payload.status === "queued" || payload.status === "initiated" || payload.status === "paid") {
      return { status: "accepted", providerReference: givenId };
    }
    if (payload.status === "failed" || payload.status === "canceled") {
      return { status: "rejected", code: `MOYASAR_PAYOUT_${String(payload.status).toUpperCase()}` };
    }
    if (payload.status === "returned") {
      return { status: "unknown", code: "MOYASAR_PAYOUT_RETURNED_RECONCILIATION_REQUIRED" };
    }
    return { status: "unknown", code: "MOYASAR_PAYOUT_RESPONSE_UNVERIFIABLE" };
  }

  /** Fetches provider state for reconciliation; it never submits or retries a payout. */
  async fetchPayout(input: {
    outboxId: string;
    providerReference: string;
    amountMinor: number;
    currency: string;
  }): Promise<
    | { outcome: "found"; status: "queued" | "initiated" | "paid" | "failed" | "canceled" | "returned"; updatedAt: string }
    | { outcome: "unknown"; code: string }
    | { outcome: "rejected"; code: string }
  > {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.outboxId) ||
        !uuidPattern.test(input.providerReference) ||
        !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 ||
        !/^[A-Z]{3}$/.test(input.currency)) {
      return { outcome: "rejected", code: "INVALID_MOYASAR_PAYOUT_LOOKUP" };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.moyasar.com/v1/payout/${encodeURIComponent(input.providerReference)}`,
        {
          method: "GET",
          headers: {
            authorization: `Basic ${Buffer.from(`${this.options.secretKey}:`, "utf8").toString("base64")}`,
            accept: "application/json"
          },
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs)
        }
      );
    } catch {
      return { outcome: "unknown", code: "MOYASAR_PAYOUT_LOOKUP_UNKNOWN" };
    }
    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500 || response.status === 404) {
      return { outcome: "unknown", code: "MOYASAR_PAYOUT_LOOKUP_UNKNOWN" };
    }
    if (!response.ok) return { outcome: "rejected", code: `MOYASAR_PAYOUT_LOOKUP_HTTP_${response.status}` };

    let payload: MoyasarPayoutPayload & { updated_at?: unknown };
    try {
      const raw = await response.text();
      if (raw.length > 32_768) throw new Error("oversized");
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return { outcome: "unknown", code: "MOYASAR_PAYOUT_LOOKUP_UNVERIFIABLE" };
    }
    const status = payload.status;
    if (payload.id !== input.providerReference || payload.source_id !== this.options.sourceId ||
        payload.amount !== input.amountMinor || payload.currency !== input.currency ||
        typeof payload.metadata !== "object" || payload.metadata === null ||
        (payload.metadata as Record<string, unknown>).outlet_window_outbox_id !== input.outboxId ||
        !["queued", "initiated", "paid", "failed", "canceled", "returned"].includes(String(status)) ||
        typeof payload.updated_at !== "string" || !Number.isFinite(Date.parse(payload.updated_at))) {
      return { outcome: "unknown", code: "MOYASAR_PAYOUT_LOOKUP_MISMATCH" };
    }
    return {
      outcome: "found",
      status: status as "queued" | "initiated" | "paid" | "failed" | "canceled" | "returned",
      updatedAt: payload.updated_at
    };
  }

}
