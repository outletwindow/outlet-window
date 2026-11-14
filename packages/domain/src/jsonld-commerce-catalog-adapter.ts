import { createHash } from "node:crypto";
import {
  hostMatchesAllowlist,
  type CommerceCatalogAdapter,
  type CommerceCatalogImportPage,
  type CommerceCatalogImportRequest,
  type CommerceProviderDescriptor,
  type NormalizedCommerceProduct
} from "./commerce-connectors.js";

export interface SafeMerchantPageFetcher {
  /** Implementations must enforce DNS/IP SSRF protection, redirect revalidation,
   * response byte limits, timeout, content type, and per-host rate limits. */
  fetchHtml(url: URL): Promise<{ html: string; finalUrl: string; capturedAtUtc: string }>;
}

type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const asText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const asList = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined ? [] : [value];
const schemaType = (value: unknown): string[] => asList(value).filter((v): v is string => typeof v === "string");

function collectProducts(value: unknown, output: JsonObject[]): void {
  if (Array.isArray(value)) { for (const item of value) collectProducts(item, output); return; }
  const object = asObject(value);
  if (!object) return;
  const types = schemaType(object["@type"]);
  if (types.some(type => type === "Product" || type === "ProductGroup")) output.push(object);
  if (object["@graph"] !== undefined) collectProducts(object["@graph"], output);
  if (object.itemListElement !== undefined) collectProducts(object.itemListElement, output);
  if (object.mainEntity !== undefined) collectProducts(object.mainEntity, output);
}

function parseJsonLd(html: string): JsonObject[] {
  const products: JsonObject[] = [];
  const scripts = html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi);
  for (const match of scripts) {
    try { collectProducts(JSON.parse(match[1] ?? ""), products); } catch { /* Ignore malformed unrelated blocks. */ }
  }
  return products;
}

function absoluteHttps(value: unknown, base: URL, allowedHosts: readonly string[]): string | undefined {
  const raw = asText(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !hostMatchesAllowlist(url.hostname, allowedHosts)) return undefined;
    return url.toString();
  } catch { return undefined; }
}

function priceMinor(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000_000) return undefined;
  return Math.round(parsed * 100);
}

function productRecord(
  source: JsonObject, pageUrl: URL, descriptor: CommerceProviderDescriptor,
  tenantId: string, capturedAtUtc: string, digest: string
): NormalizedCommerceProduct | null {
  const name = asText(source.name);
  const externalId = asText(source.sku) ?? asText(source.productID) ?? asText(source.mpn);
  if (!name || !externalId) return null;
  const canonicalUrl = absoluteHttps(source.url ?? pageUrl.toString(), pageUrl, descriptor.websiteHosts);
  if (!canonicalUrl) return null;
  const brandObject = asObject(source.brand);
  const brand = asText(brandObject?.name) ?? asText(source.brand);
  const images = asList(source.image).map(value => typeof value === "string" ? value : asText(asObject(value)?.url))
    .map(value => absoluteHttps(value, pageUrl, descriptor.websiteHosts)).filter((value): value is string => Boolean(value));
  const offers = asObject(source.offers);
  const offerList = asList(source.offers).map(asObject).filter((value): value is JsonObject => Boolean(value));
  const offer = offers ?? offerList[0];
  const currency = asText(offer?.priceCurrency);
  const normalizedCurrency = currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined;
  const rawPrice = offer?.price ?? offer?.lowPrice;
  const normalizedPrice = priceMinor(rawPrice);
  const description = asText(source.description);
  const variants = asList(source.hasVariant).map(asObject).filter((value): value is JsonObject => Boolean(value))
    .map((variant, index) => {
      const variantOffer = asObject(variant.offers);
      const variantSize = asText(variant.size);
      const variantColor = asText(variant.color);
      const variantPrice = priceMinor(variantOffer?.price);
      const variantCurrency = asText(variantOffer?.priceCurrency);
      return {
        externalId: asText(variant.sku) ?? asText(variant.productID) ?? `${externalId}-variant-${index + 1}`,
        ...(variantSize !== undefined ? { sizeLabel: variantSize } : {}),
        ...(variantColor !== undefined ? { colorLabel: variantColor } : {}),
        ...(variantPrice !== undefined ? { priceMinor: variantPrice } : {}),
        ...(variantCurrency !== undefined ? { currency: variantCurrency } : {})
      };
    });
  const sizeChartUrl = absoluteHttps(source.sizeChartUrl ?? source.sizeGuideUrl, pageUrl, descriptor.websiteHosts);
  return {
    tenantId, providerKey: descriptor.providerKey, externalProductId: externalId,
    canonicalUrl, title: name,
    ...(description !== undefined ? { description } : {}),
    ...(brand !== undefined ? { brand } : {}),
    ...(normalizedCurrency !== undefined ? { currency: normalizedCurrency } : {}),
    ...(normalizedPrice !== undefined ? { priceMinor: normalizedPrice } : {}),
    imageUrls: [...new Set(images)], variants,
    ...(sizeChartUrl ? { sizeChartUrl } : {}),
    sourceType: "structured_data", sourceCapturedAtUtc: capturedAtUtc,
    sourceContentSha256: digest
  };
}

/** Structured-data product-page adapter. It intentionally does not crawl
 * category pages or infer unavailable sizes/prices from visible text. */
export class JsonLdCommerceCatalogAdapter implements CommerceCatalogAdapter {
  constructor(
    readonly descriptor: CommerceProviderDescriptor,
    private readonly fetcher: SafeMerchantPageFetcher
  ) {}

  validateSourceUrl(url: URL): boolean {
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      hostMatchesAllowlist(url.hostname, this.descriptor.websiteHosts);
  }

  async importPage(request: CommerceCatalogImportRequest): Promise<CommerceCatalogImportPage> {
    const requestedUrl = new URL(request.sourceUrl);
    if (!this.validateSourceUrl(requestedUrl)) throw new Error("UNTRUSTED_CATALOG_SOURCE");
    if (request.cursor) throw new Error("STRUCTURED_DATA_ADAPTER_DOES_NOT_SUPPORT_CURSORS");
    const response = await this.fetcher.fetchHtml(requestedUrl);
    const finalUrl = new URL(response.finalUrl);
    if (!this.validateSourceUrl(finalUrl)) throw new Error("UNTRUSTED_MERCHANT_REDIRECT");
    if (typeof response.html !== "string" || response.html.length > 2_000_000 ||
        !response.capturedAtUtc.endsWith("Z") || !Number.isFinite(Date.parse(response.capturedAtUtc))) {
      throw new Error("INVALID_MERCHANT_PAGE_RESPONSE");
    }
    const digest = createHash("sha256").update(response.html, "utf8").digest("hex");
    const products = parseJsonLd(response.html)
      .map(item => productRecord(item, finalUrl, this.descriptor, request.tenantId, response.capturedAtUtc, digest))
      .filter((item): item is NormalizedCommerceProduct => item !== null);
    return { products, completed: true, capturedAtUtc: response.capturedAtUtc };
  }
}
