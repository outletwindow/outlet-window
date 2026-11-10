import { MoyasarPaymentIntentClient } from "../../../packages/domain/src/moyasar-payment-intent-client.js";

export interface MoyasarCheckoutEnvironment {
  MOYASAR_SECRET_KEY?: string | undefined;
  MOYASAR_PAYMENT_CALLBACK_URL?: string | undefined;
  MOYASAR_WEBHOOK_SECRET?: string | undefined;
  MOYASAR_EXPECT_LIVE?: string | undefined;
}

export interface MoyasarCheckoutRuntimeConfig {
  client: MoyasarPaymentIntentClient;
  callbackUrl: string;
}

/** Builds a fail-closed server-side Moyasar checkout configuration from deployment secrets. */
export function createMoyasarCheckoutRuntimeConfig(
  environment: MoyasarCheckoutEnvironment
): MoyasarCheckoutRuntimeConfig | null {
  const secretKey = environment.MOYASAR_SECRET_KEY?.trim() ?? "";
  const callbackValue = environment.MOYASAR_PAYMENT_CALLBACK_URL?.trim() ?? "";
  if (!secretKey && !callbackValue) return null;
  if (!secretKey || !callbackValue || !environment.MOYASAR_WEBHOOK_SECRET?.trim()) {
    throw new Error("MOYASAR_CHECKOUT_REQUIRES_SECRET_KEY_CALLBACK_URL_AND_WEBHOOK_SECRET");
  }
  if (environment.MOYASAR_EXPECT_LIVE !== "true" && environment.MOYASAR_EXPECT_LIVE !== "false") {
    throw new Error("MOYASAR_EXPECT_LIVE_MUST_MATCH_PROVIDER_MODE");
  }
  const expectedLive = environment.MOYASAR_EXPECT_LIVE === "true";
  if (secretKey.startsWith("sk_live_") !== expectedLive) {
    throw new Error("MOYASAR_SECRET_KEY_MODE_MISMATCH");
  }
  let callback: URL;
  try { callback = new URL(callbackValue); }
  catch { throw new Error("INVALID_MOYASAR_PAYMENT_CALLBACK_URL"); }
  if (callback.protocol !== "https:" || callback.username || callback.password || callback.hash) {
    throw new Error("INVALID_MOYASAR_PAYMENT_CALLBACK_URL");
  }
  return { client: new MoyasarPaymentIntentClient({ secretKey }), callbackUrl: callback.toString() };
}
