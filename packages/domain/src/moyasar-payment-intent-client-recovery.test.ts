import { describe, expect, it, vi } from "vitest";
import { MoyasarPaymentIntentClient } from "./moyasar-payment-intent-client.js";

const intentId = "8f4d1c3e-6a52-4f0b-9a1e-2c7b5d8e0f31";
const payload = {
  id: intentId,
  amount: 12_500,
  currency: "SAR",
  status: "created",
  client_secret: "pi_secret_7Kq2mXbN9vT4wPzR1sYcHdLjF6aGuE8oQ3iK5nB0xVtZrWyM",
  expires_at: "2026-11-18T09:00:00.000Z"
};

function response(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  } as Response;
}

describe("Moyasar payment intent recovery lookup", () => {
  it("classifies transient lookup responses as unknown without retrying", async () => {
    for (const status of [408, 425, 429, 500, 502, 503]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(status));
      const client = new MoyasarPaymentIntentClient({
        secretKey: "sk_test_0123456789abcdef",
        fetchImpl
      });

      await expect(client.fetchIntent(intentId)).rejects.toThrow(
        "MOYASAR_PAYMENT_INTENT_FETCH_OUTCOME_UNKNOWN"
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps definitive authentication rejection distinct from an unknown outcome", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(401));
    const client = new MoyasarPaymentIntentClient({
      secretKey: "sk_test_0123456789abcdef",
      fetchImpl
    });

    await expect(client.fetchIntent(intentId)).rejects.toThrow(
      "MOYASAR_PAYMENT_INTENT_FETCH_REJECTED"
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
