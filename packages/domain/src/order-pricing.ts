export type PriceComponentKind =
  | "product_subtotal" | "delivery" | "collection" | "platform_fee"
  | "packaging" | "tax" | "discount";

export interface PriceComponent {
  kind: PriceComponentKind;
  /** Non-negative amount in the quote currency's minor unit. Discount components are informational and excluded from subtotal. */
  amountMinor: number;
  label: string;
}

export interface PricingQuoteInput {
  quoteId: string;
  ruleId: string;
  ruleVersion: number;
  currency: string;
  components: readonly PriceComponent[];
  /** Explicit discount total in minor units; must match any discount components supplied. */
  discountMinor?: number;
  createdAtUtc: string;
  expiresAtUtc: string;
}

export interface PricingQuote {
  quoteId: string;
  ruleId: string;
  ruleVersion: number;
  currency: string;
  components: readonly PriceComponent[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  createdAtUtc: string;
  expiresAtUtc: string;
}

/** Pure, deterministic quote calculation. It applies no market rates or taxes implicitly. */
export function calculatePricingQuote(input: PricingQuoteInput): PricingQuote {
  if (!input.quoteId.trim() || !input.ruleId.trim() ||
      !Number.isSafeInteger(input.ruleVersion) || input.ruleVersion < 1) {
    throw new Error("invalid_pricing_rule");
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error("invalid_currency");
  const created = Date.parse(input.createdAtUtc);
  const expires = Date.parse(input.expiresAtUtc);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created) {
    throw new Error("invalid_quote_window");
  }
  if (!Array.isArray(input.components) || input.components.length === 0) {
    throw new Error("pricing_components_required");
  }
  let subtotal = 0;
  let componentDiscount = 0;
  let hasDiscountComponent = false;
  const components = input.components.map(component => {
    if (!component.label.trim() || !Number.isSafeInteger(component.amountMinor) ||
        component.amountMinor < 0 ||
        !["product_subtotal", "delivery", "collection", "platform_fee", "packaging", "tax", "discount"].includes(component.kind)) {
      throw new Error("invalid_price_component");
    }
    if (component.kind === "discount") {
      hasDiscountComponent = true;
      componentDiscount += component.amountMinor;
      if (!Number.isSafeInteger(componentDiscount)) throw new Error("price_overflow");
    } else {
      subtotal += component.amountMinor;
      if (!Number.isSafeInteger(subtotal)) throw new Error("price_overflow");
    }
    return { ...component };
  });
  const discount = input.discountMinor ?? 0;
  if (!Number.isSafeInteger(discount) || discount < 0 || discount > subtotal) {
    throw new Error("invalid_discount");
  }
  if (hasDiscountComponent && componentDiscount !== discount) {
    throw new Error("discount_component_mismatch");
  }
  return {
    quoteId: input.quoteId, ruleId: input.ruleId, ruleVersion: input.ruleVersion,
    currency: input.currency, components, subtotalMinor: subtotal,
    discountMinor: discount, totalMinor: subtotal - discount,
    createdAtUtc: new Date(created).toISOString(),
    expiresAtUtc: new Date(expires).toISOString()
  };
}

/** Quotes are immutable snapshots; a client cannot extend or reuse an expired quote. */
export function isPricingQuoteUsable(quote: PricingQuote, nowUtc: string): boolean {
  const now = Date.parse(nowUtc);
  const created = Date.parse(quote.createdAtUtc);
  const expires = Date.parse(quote.expiresAtUtc);
  return Number.isFinite(now) && Number.isFinite(created) && Number.isFinite(expires) &&
    now >= created && now < expires && Number.isSafeInteger(quote.totalMinor) &&
    quote.totalMinor >= 0 && /^[A-Z]{3}$/.test(quote.currency);
}
