import { createHmac, timingSafeEqual } from "node:crypto";

export interface PaymentAdjustmentCommand {
  adjustmentId: string;
  orderId: string;
  idempotencyKey: string;
  direction: "additional_charge" | "refund";
  amountMinor: number;
  currency: string;
  customerId: string;
}
export type PaymentAdjustmentSubmission =
  | { status: "accepted"; providerReference: string }
  | { status: "retry"; code: string }
  | { status: "rejected"; code: string };

export interface PaymentAdjustmentProvider {
  submit(command: PaymentAdjustmentCommand): Promise<PaymentAdjustmentSubmission>;
}

export type PaymentFetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function validateHttpsEndpoint(value: string | undefined): string {
  if (!value) throw new Error("PAYMENT_ADJUSTMENT_ENDPOINT_REQUIRED");
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new Error("PAYMENT_ADJUSTMENT_ENDPOINT_INVALID"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.hash || endpoint.search) throw new Error("PAYMENT_ADJUSTMENT_ENDPOINT_MUST_BE_HTTPS");
  return endpoint.toString();
}

/** Generic deployment-controlled gateway adapter; it does not assume a specific PSP. */
export function createHttpPaymentAdjustmentProvider(options: {
  endpoint?: string;
  bearerToken?: string;
  fetchImpl?: PaymentFetchLike;
  timeoutMs?: number;
}): PaymentAdjustmentProvider {
  const endpoint = validateHttpsEndpoint(options.endpoint);
  if (!options.bearerToken?.trim()) throw new Error("PAYMENT_ADJUSTMENT_TOKEN_REQUIRED");
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
    throw new Error("PAYMENT_ADJUSTMENT_TIMEOUT_INVALID");
  }
  const fetcher = options.fetchImpl ?? fetch;
  return {
    async submit(command) {
      if (!command.adjustmentId.trim() || !command.orderId.trim() ||
          !command.idempotencyKey.trim() || !command.customerId.trim() ||
          !/^[A-Z]{3}$/.test(command.currency) ||
          !Number.isSafeInteger(command.amountMinor) || command.amountMinor <= 0) {
        return { status: "rejected", code: "INVALID_ADJUSTMENT_COMMAND" };
      }
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: "Bearer " + options.bearerToken,
            "content-type": "application/json",
            accept: "application/json",
            "idempotency-key": command.idempotencyKey
          },
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch {
        return { status: "retry", code: "PAYMENT_PROVIDER_NETWORK_ERROR" };
      }
      if (response.status === 408 || response.status === 425 ||
          response.status === 429 || response.status >= 500) {
        return { status: "retry", code: "PAYMENT_PROVIDER_TEMPORARY_FAILURE" };
      }
      if (!response.ok) return { status: "rejected", code: "PAYMENT_PROVIDER_HTTP_" + response.status };
      let payload: unknown;
      try {
        const raw = await response.text();
        if (raw.length > 16_384) return { status: "retry", code: "PAYMENT_PROVIDER_INVALID_RESPONSE" };
        payload = JSON.parse(raw) as unknown;
      } catch {
        return { status: "retry", code: "PAYMENT_PROVIDER_INVALID_RESPONSE" };
      }
      if (typeof payload !== "object" || payload === null ||
          (payload as { status?: unknown }).status !== "accepted" ||
          typeof (payload as { providerReference?: unknown }).providerReference !== "string" ||
          !(payload as { providerReference: string }).providerReference.trim() ||
          (payload as { providerReference: string }).providerReference.length > 240) {
        return { status: "retry", code: "PAYMENT_PROVIDER_INVALID_RESPONSE" };
      }
      return { status: "accepted", providerReference: (payload as { providerReference: string }).providerReference };
    }
  };
}

/**
 * Verifies a provider webhook signature over the exact raw request body.
 * Header format: t=<unix-seconds>,v1=<hex-hmac-sha256>.
 * Enforce a short timestamp tolerance to reduce replay risk; persist event IDs separately
 * before applying state transitions for full webhook idempotency.
 */
export function verifyPaymentProviderWebhook(input: {
  rawBody: string;
  signatureHeader: string | undefined;
  secret: string | undefined;
  nowUtc?: Date;
  toleranceSeconds?: number;
}): boolean {
  if (!input.secret || input.secret.length < 32 || !input.signatureHeader ||
      input.rawBody.length > 65_536) return false;
  const fields = Object.fromEntries(input.signatureHeader.split(",").map(part => {
    const index = part.indexOf("=");
    return index < 0 ? ["", ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
  if (!/^\d{10}$/.test(fields.t ?? "") || !/^[a-f0-9]{64}$/i.test(fields.v1 ?? "")) return false;
  const timestamp = Number(fields.t);
  const nowSeconds = Math.floor((input.nowUtc ?? new Date()).getTime() / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(tolerance) || tolerance < 30 || tolerance > 600 ||
      Math.abs(nowSeconds - timestamp) > tolerance) return false;
  const expected = createHmac("sha256", input.secret).update(fields.t + "." + input.rawBody, "utf8").digest();
  const supplied = Buffer.from(fields.v1 ?? "", "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
