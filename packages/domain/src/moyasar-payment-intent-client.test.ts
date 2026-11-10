import { describe, expect, it, vi } from "vitest";
import { MoyasarPaymentIntentClient } from "./moyasar-payment-intent-client.js";

const now = new Date("2026-11-10T08:00:00.000Z");
const validPayload = {
  id: "8f4d1c3e-6a52-4f0b-9a1e-2c7b5d8e0f31",
  amount: 12_500,
  currency: "SAR",
  status: "created",
  client_secret: "pi_secret_7Kq2mXbN9vT4wPzR1sYcHdLjF6aGuE8oQ3iK5nB0xVtZrWyM",
  expires_at: "2026-11-10T09:00:00.000Z"
};

function response(payload: unknown, status = 201): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response;
}

describe("Moyasar payment intent client", () => {
  it("creates an intent with backend-only Basic authentication and returns the one-time client secret", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(validPayload));
    const client = new MoyasarPaymentIntentClient({
      secretKey: "sk_test_0123456789abcdef",
      fetchImpl,
      now: () => now
    });
    const result = await client.createIntent({
      amountMinor: 12_500,
      currency: "SAR",
      description: "Outlet Window order",
      callbackUrl: "https://shop.example.com/checkout/return"
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.moyasar.com/v1/payment_intents");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("sk_test_0123456789abcdef:").toString("base64")}`
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      amount: 12_500,
      currency: "SAR",
      description: "Outlet Window order",
      callback_url: "https://shop.example.com/checkout/return"
    });
    expect(result).toEqual({
      id: validPayload.id,
      amount: 12_500,
      currency: "SAR",
      clientSecret: validPayload.client_secret,
      expiresAtUtc: validPayload.expires_at
    });
  });

  it("rejects invalid keys and unsafe or malformed checkout inputs before making a request", async () => {
    expect(() => new MoyasarPaymentIntentClient({ secretKey: "pk_test_publishable" }))
      .toThrow("INVALID_MOYASAR_SECRET_KEY");
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new MoyasarPaymentIntentClient({ secretKey: "sk_test_0123456789", fetchImpl });
    await expect(client.createIntent({
      amountMinor: 99, currency: "SAR", callbackUrl: "https://shop.example.com/return"
    })).rejects.toThrow("INVALID_MOYASAR_PAYMENT_INTENT_REQUEST");
    await expect(client.createIntent({
      amountMinor: 100, currency: "SAR", callbackUrl: "http://shop.example.com/return"
    })).rejects.toThrow("INVALID_MOYASAR_PAYMENT_INTENT_REQUEST");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not expose provider response bodies or secrets when the provider rejects a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ message: "contains private details" }, 401));
    const client = new MoyasarPaymentIntentClient({ secretKey: "sk_test_0123456789", fetchImpl });
    await expect(client.createIntent({
      amountMinor: 100, currency: "SAR", callbackUrl: "https://shop.example.com/return"
    })).rejects.toThrow("MOYASAR_PAYMENT_INTENT_PROVIDER_REJECTED");
  });

  it("treats transport failures as ambiguous and never retries automatically", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("network reset"));
    const client = new MoyasarPaymentIntentClient({ secretKey: "sk_test_0123456789", fetchImpl });
    await expect(client.createIntent({
      amountMinor: 100, currency: "SAR", callbackUrl: "https://shop.example.com/return"
    })).rejects.toThrow("MOYASAR_PAYMENT_INTENT_OUTCOME_UNKNOWN");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched, fulfilled, expired, and malformed provider responses", async () => {
    const variants = [
      { ...validPayload, amount: 12_499 },
      { ...validPayload, status: "fulfilled" },
      { ...validPayload, expires_at: "2026-11-10T07:59:59.000Z" },
      { ...validPayload, client_secret: "sk_test_not_a_client_secret" },
      { ...validPayload, expires_at: "2026-11-10T10:00:00.000Z" }
    ];
    for (const payload of variants) {
      const client = new MoyasarPaymentIntentClient({
        secretKey: "sk_test_0123456789",
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(payload)),
        now: () => now
      });
      await expect(client.createIntent({
        amountMinor: 12_500, currency: "SAR", callbackUrl: "https://shop.example.com/return"
      })).rejects.toThrow("MOYASAR_PAYMENT_INTENT_INVALID_RESPONSE");
    }
  });
});
