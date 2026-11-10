import { timingSafeEqual } from "node:crypto";
import type { PaymentCaptureWebhookVerifier } from "./verified-order-payment-capture-webhook.js";

/**
 * Moyasar's documented webhook envelope carries secret_token in the JSON body.
 * Verify it against the configured per-endpoint shared secret before decoding
 * the event. The provider's event ID/account name are required envelope fields.
 */
export const moyasarWebhookVerifier: PaymentCaptureWebhookVerifier = {
  verify({ rawBody, secret }) {
    if (!rawBody || rawBody.length > 65_536 || !secret || secret.length > 4096) return false;
    let payload: unknown;
    try { payload = JSON.parse(rawBody) as unknown; } catch { return false; }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
    const envelope = payload as Record<string, unknown>;
    if (typeof envelope.id !== "string" || !envelope.id.trim() ||
        typeof envelope.type !== "string" || !envelope.type.trim() ||
        typeof envelope.created_at !== "string" || !Number.isFinite(Date.parse(envelope.created_at)) ||
        typeof envelope.live !== "boolean" || typeof envelope.data !== "object" ||
        envelope.data === null || Array.isArray(envelope.data) ||
        typeof envelope.account_name !== "string" || !envelope.account_name.trim() ||
        typeof envelope.secret_token !== "string" || !envelope.secret_token) return false;
    const supplied = Buffer.from(envelope.secret_token, "utf8");
    const expected = Buffer.from(secret, "utf8");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
};
