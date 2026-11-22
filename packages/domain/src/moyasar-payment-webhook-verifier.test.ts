import { describe, expect, it } from "vitest";
import { createMoyasarWebhookVerifier, moyasarWebhookVerifier } from "./moyasar-payment-webhook-verifier.js";

describe("Moyasar webhook verifier", () => {
  const secret = "moyasar-endpoint-shared-secret";
  const body = JSON.stringify({
    id: "evt_123",
    type: "payment_captured",
    created_at: "2026-11-10T07:00:00Z",
    secret_token: secret,
    account_name: "Outlet Window",
    live: false,
    data: { id: "pay_123" }
  });

  it("accepts a valid Moyasar envelope using its configured shared secret", () => {
    expect(moyasarWebhookVerifier.verify({ rawBody: body, secret })).toBe(true);
  });

  it("rejects a wrong secret, missing envelope fields, malformed JSON and oversized bodies", () => {
    expect(moyasarWebhookVerifier.verify({ rawBody: body, secret: "wrong-secret" })).toBe(false);
    expect(moyasarWebhookVerifier.verify({
      rawBody: JSON.stringify({ ...JSON.parse(body), secret_token: undefined }), secret
    })).toBe(false);
    expect(moyasarWebhookVerifier.verify({ rawBody: "{", secret })).toBe(false);
    expect(moyasarWebhookVerifier.verify({ rawBody: "x".repeat(65_537), secret })).toBe(false);
  });

  it("binds the endpoint to the configured test/live mode", () => {
    const liveBody = JSON.stringify({ ...JSON.parse(body), live: true });
    expect(createMoyasarWebhookVerifier(true).verify({ rawBody: liveBody, secret })).toBe(true);
    expect(createMoyasarWebhookVerifier(false).verify({ rawBody: liveBody, secret })).toBe(false);
  });

  it("does not accept arrays or non-object JSON as webhook envelopes", () => {
    expect(moyasarWebhookVerifier.verify({ rawBody: "[]", secret })).toBe(false);
    expect(moyasarWebhookVerifier.verify({ rawBody: "null", secret })).toBe(false);
  });
});
