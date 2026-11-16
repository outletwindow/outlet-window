import { describe, expect, it } from "vitest";
import { createMoyasarCheckoutRuntimeConfig } from "./moyasar-checkout-runtime-config.js";

const valid = {
  MOYASAR_SECRET_KEY: "sk_test_0123456789abcdef",
  MOYASAR_PAYMENT_CALLBACK_URL: "https://app.example.com/payments/moyasar/return",
  MOYASAR_WEBHOOK_SECRET: "moyasar-webhook-secret",
  MOYASAR_EXPECT_LIVE: "false"
};

describe("Moyasar checkout runtime configuration", () => {
  it("keeps checkout disabled when no checkout credentials are supplied", () => {
    expect(createMoyasarCheckoutRuntimeConfig({})).toBeNull();
  });

  it("creates a backend-only client and canonical HTTPS callback when fully configured", () => {
    const config = createMoyasarCheckoutRuntimeConfig(valid);
    expect(config?.client).toBeTruthy();
    expect(config?.callbackUrl).toBe("https://app.example.com/payments/moyasar/return");
  });

  it("fails closed when only part of the checkout configuration is present", () => {
    expect(() => createMoyasarCheckoutRuntimeConfig({
      MOYASAR_SECRET_KEY: valid.MOYASAR_SECRET_KEY
    })).toThrow("MOYASAR_CHECKOUT_REQUIRES_SECRET_KEY_CALLBACK_URL_AND_WEBHOOK_SECRET");
    expect(() => createMoyasarCheckoutRuntimeConfig({
      MOYASAR_PAYMENT_CALLBACK_URL: valid.MOYASAR_PAYMENT_CALLBACK_URL
    })).toThrow("MOYASAR_CHECKOUT_REQUIRES_SECRET_KEY_CALLBACK_URL_AND_WEBHOOK_SECRET");
  });

  it("requires an explicit provider mode and prevents test/live key crossover", () => {
    expect(() => createMoyasarCheckoutRuntimeConfig({
      ...valid, MOYASAR_EXPECT_LIVE: undefined
    })).toThrow("MOYASAR_EXPECT_LIVE_MUST_MATCH_PROVIDER_MODE");
    expect(() => createMoyasarCheckoutRuntimeConfig({
      ...valid, MOYASAR_SECRET_KEY: "sk_live_0123456789abcdef"
    })).toThrow("MOYASAR_SECRET_KEY_MODE_MISMATCH");
    expect(() => createMoyasarCheckoutRuntimeConfig({
      ...valid, MOYASAR_EXPECT_LIVE: "true", MOYASAR_SECRET_KEY: "sk_test_0123456789abcdef"
    })).toThrow("MOYASAR_SECRET_KEY_MODE_MISMATCH");
  });

  it("rejects insecure, credential-bearing, or fragment callback URLs", () => {
    for (const callback of [
      "http://app.example.com/payment-return",
      "https://user:password@app.example.com/payment-return",
      "https://app.example.com/payment-return#secret"
    ]) {
      expect(() => createMoyasarCheckoutRuntimeConfig({
        ...valid, MOYASAR_PAYMENT_CALLBACK_URL: callback
      })).toThrow("INVALID_MOYASAR_PAYMENT_CALLBACK_URL");
    }
  });
});
