export interface MoyasarPaymentIntent {
  id: string;
  amount: number;
  currency: string;
  clientSecret: string;
  expiresAtUtc: string;
}

export interface MoyasarPaymentIntentRequest {
  amountMinor: number;
  currency: string;
  description?: string;
  callbackUrl: string;
}

export interface MoyasarPaymentIntentClientOptions {
  secretKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

type MoyasarIntentResponse = {
  id?: unknown;
  amount?: unknown;
  currency?: unknown;
  client_secret?: unknown;
  status?: unknown;
  expires_at?: unknown;
};

/**
 * Server-side Moyasar Payment Intents client.
 *
 * The secret key is used only for the backend request. The returned client
 * secret is a credential and must only be delivered to the authenticated
 * customer over HTTPS; callers must never log it or place it in a URL.
 *
 * Moyasar does not document an idempotency key for intent creation. Callers
 * must not blindly retry an ambiguous network failure, as that could create
 * another provider intent.
 */
export class MoyasarPaymentIntentClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(private readonly options: MoyasarPaymentIntentClientOptions) {
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(options.secretKey)) {
      throw new Error("INVALID_MOYASAR_SECRET_KEY");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new Error("INVALID_MOYASAR_TIMEOUT");
    }
  }

  async createIntent(input: MoyasarPaymentIntentRequest): Promise<MoyasarPaymentIntent> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 100 ||
        !/^[A-Z]{3}$/.test(input.currency) ||
        (input.description !== undefined && input.description.length > 8_000) ||
        typeof input.callbackUrl !== "string" || input.callbackUrl.length > 2_048) {
      throw new Error("INVALID_MOYASAR_PAYMENT_INTENT_REQUEST");
    }
    let callbackUrl: URL;
    try { callbackUrl = new URL(input.callbackUrl); }
    catch { throw new Error("INVALID_MOYASAR_PAYMENT_INTENT_REQUEST"); }
    if (callbackUrl.protocol !== "https:" || callbackUrl.username || callbackUrl.password) {
      throw new Error("INVALID_MOYASAR_PAYMENT_INTENT_REQUEST");
    }

    let response: Response;
    try {
      response = await this.fetchImpl("https://api.moyasar.com/v1/payment_intents", {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.options.secretKey}:`, "utf8").toString("base64")}`,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          amount: input.amountMinor,
          currency: input.currency,
          ...(input.description === undefined ? {} : { description: input.description }),
          callback_url: callbackUrl.toString()
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      // Deliberately do not retry: the provider may have created the intent
      // even when the response was lost.
      throw new Error("MOYASAR_PAYMENT_INTENT_OUTCOME_UNKNOWN");
    }
    if (!response.ok) throw new Error("MOYASAR_PAYMENT_INTENT_PROVIDER_REJECTED");

    let payload: MoyasarIntentResponse;
    try { payload = await response.json() as MoyasarIntentResponse; }
    catch { throw new Error("MOYASAR_PAYMENT_INTENT_INVALID_RESPONSE"); }

    const expiry = typeof payload.expires_at === "string" ? Date.parse(payload.expires_at) : Number.NaN;
    const now = this.now().getTime();
    if (typeof payload.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.id) ||
        payload.status !== "created" ||
        payload.amount !== input.amountMinor || payload.currency !== input.currency ||
        typeof payload.client_secret !== "string" || !/^pi_secret_[A-Za-z0-9_-]{12,}$/.test(payload.client_secret) ||
        !Number.isFinite(expiry) || expiry <= now || expiry > now + 65 * 60_000) {
      throw new Error("MOYASAR_PAYMENT_INTENT_INVALID_RESPONSE");
    }

    return {
      id: payload.id,
      amount: input.amountMinor,
      currency: input.currency,
      clientSecret: payload.client_secret,
      expiresAtUtc: new Date(expiry).toISOString()
    };
  }
}
