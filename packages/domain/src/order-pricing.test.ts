import { describe, expect, it } from "vitest";
import { calculatePricingQuote, isPricingQuoteUsable } from "./order-pricing.js";

const base = {
  quoteId: "quote-1", ruleId: "jubail-standard", ruleVersion: 1, currency: "SAR",
  components: [
    { kind: "product_subtotal" as const, amountMinor: 25_000, label: "Products" },
    { kind: "delivery" as const, amountMinor: 1_500, label: "Delivery" },
    { kind: "tax" as const, amountMinor: 3_975, label: "Tax" }
  ],
  discountMinor: 500,
  createdAtUtc: "2026-11-08T12:00:00.000Z",
  expiresAtUtc: "2026-11-08T12:05:00.000Z"
};

describe("deterministic pricing quotes", () => {
  it("calculates totals using integer minor units and preserves rule snapshots", () => {
    expect(calculatePricingQuote(base)).toMatchObject({
      ruleId: "jubail-standard", ruleVersion: 1, currency: "SAR",
      subtotalMinor: 30_475, discountMinor: 500, totalMinor: 29_975
    });
  });

  it("rejects negative, fractional, excessive discounts and unsafe totals", () => {
    expect(() => calculatePricingQuote({ ...base, discountMinor: -1 })).toThrow("invalid_discount");
    expect(() => calculatePricingQuote({ ...base, discountMinor: 40_000 })).toThrow("invalid_discount");
    expect(() => calculatePricingQuote({ ...base, components: [
      { kind: "delivery", amountMinor: 1.5, label: "Bad precision" }
    ] })).toThrow("invalid_price_component");
    expect(() => calculatePricingQuote({ ...base, components: [
      { kind: "delivery", amountMinor: Number.MAX_SAFE_INTEGER, label: "A" },
      { kind: "delivery", amountMinor: 1, label: "B" }
    ] })).toThrow("price_overflow");
  });

  it("rejects invalid currency and quote validity windows", () => {
    expect(() => calculatePricingQuote({ ...base, currency: "SR" })).toThrow("invalid_currency");
    expect(() => calculatePricingQuote({ ...base, expiresAtUtc: base.createdAtUtc })).toThrow("invalid_quote_window");
  });

  it("accepts only quotes within their original time window", () => {
    const quote = calculatePricingQuote(base);
    expect(isPricingQuoteUsable(quote, "2026-11-08T12:04:59.999Z")).toBe(true);
    expect(isPricingQuoteUsable(quote, "2026-11-08T12:05:00.000Z")).toBe(false);
    expect(isPricingQuoteUsable(quote, "2026-11-08T11:59:59.999Z")).toBe(false);
  });
});
