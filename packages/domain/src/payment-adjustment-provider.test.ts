import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createHttpPaymentAdjustmentProvider,
  verifyPaymentProviderWebhook
} from "./payment-adjustment-provider.js";

describe("payment adjustment provider adapter", () => {
  const command = {
    adjustmentId: "adjustment-1", orderId: "order-1", idempotencyKey: "adjustment-key-001",
    direction: "additional_charge" as const, amountMinor: 2500, currency: "SAR", customerId: "customer-1"
  };

  it("requires HTTPS and a deployment-provided token", () => {
    expect(() => createHttpPaymentAdjustmentProvider({ endpoint: "http://gateway.test/pay", bearerToken: "token" }))
      .toThrow("PAYMENT_ADJUSTMENT_ENDPOINT_MUST_BE_HTTPS");
    expect(() => createHttpPaymentAdjustmentProvider({ endpoint: "https://gateway.test/pay" }))
      .toThrow("PAYMENT_ADJUSTMENT_TOKEN_REQUIRED");
  });

  it("sends an idempotent provider request and accepts only an explicit provider reference", async () => {
    let request: RequestInit | undefined;
    const provider = createHttpPaymentAdjustmentProvider({
      endpoint: "https://gateway.example/payments/adjust",
      bearerToken: "secret-token",
      fetchImpl: async (_url, init) => {
        request = init;
        return new Response(JSON.stringify({ status: "accepted", providerReference: "psp-ref-1" }), { status: 200 });
      }
    });
    await expect(provider.submit(command)).resolves.toEqual({ status: "accepted", providerReference: "psp-ref-1" });
    expect(request?.redirect).toBe("error");
    expect(new Headers(request?.headers).get("idempotency-key")).toBe(command.idempotencyKey);
    expect(JSON.parse(String(request?.body))).toMatchObject({ amountMinor: 2500, currency: "SAR" });
  });

  it("does not treat malformed or non-success provider responses as confirmed", async () => {
    const malformed = createHttpPaymentAdjustmentProvider({
      endpoint: "https://gateway.example/payments/adjust", bearerToken: "secret-token",
      fetchImpl: async () => new Response(JSON.stringify({ status: "accepted" }), { status: 200 })
    });
    await expect(malformed.submit(command)).resolves.toMatchObject({ status: "retry" });
    const rejected = createHttpPaymentAdjustmentProvider({
      endpoint: "https://gateway.example/payments/adjust", bearerToken: "secret-token",
      fetchImpl: async () => new Response("{}", { status: 402 })
    });
    await expect(rejected.submit(command)).resolves.toMatchObject({ status: "rejected" });
  });
});

describe("payment provider webhook signature", () => {
  const secret = "a".repeat(48);
  const rawBody = JSON.stringify({ eventId: "evt-1", status: "succeeded" });
  const timestamp = "1794139200";

  function signature(body: string, time: string) {
    return createHmac("sha256", secret).update(time + "." + body).digest("hex");
  }

  it("accepts an exact-body HMAC signature within timestamp tolerance", () => {
    const nowUtc = new Date(Number(timestamp) * 1000);
    expect(verifyPaymentProviderWebhook({
      rawBody, secret, nowUtc, signatureHeader: `t=${timestamp},v1=${signature(rawBody, timestamp)}`
    })).toBe(true);
  });

  it("rejects altered bodies, stale timestamps and malformed signatures", () => {
    const nowUtc = new Date(Number(timestamp) * 1000);
    const header = `t=${timestamp},v1=${signature(rawBody, timestamp)}`;
    expect(verifyPaymentProviderWebhook({ rawBody: rawBody + " ", secret, nowUtc, signatureHeader: header })).toBe(false);
    expect(verifyPaymentProviderWebhook({ rawBody, secret, nowUtc: new Date(nowUtc.getTime() + 600_000), signatureHeader: header })).toBe(false);
    expect(verifyPaymentProviderWebhook({ rawBody, secret, nowUtc, signatureHeader: "invalid" })).toBe(false);
    expect(verifyPaymentProviderWebhook({ rawBody, secret: "short", nowUtc, signatureHeader: header })).toBe(false);
  });
});
