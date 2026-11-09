import { createHash } from "node:crypto";
import {
  type CommerceCatalogAdapter,
  type CommerceCatalogImportPage,
  type CommerceCatalogImportRequest,
  type CommerceProviderDescriptor,
  type NormalizedCommerceProduct,
  type NormalizedCommerceVariant
} from "./commerce-connectors.js";

export const SALLA_ADMIN_API_BASE = "https://api.salla.dev/admin/v2";

export interface SallaProductsResponse {
  success?: boolean;
  data?: unknown;
  pagination?: { currentPage?: number; totalPages?: number; links?: { next?: string | null } };
}
export interface SallaMerchantApi {
  /** Implemented by the API runtime: HTTPS only, fixed Salla origin, bounded timeout,
   * no redirects, rate limiting and safe JSON response-size limits. */
  listProducts(accessToken: string, page: number, perPage: number): Promise<SallaProductsResponse>;
}
export interface SallaAccessTokenProvider {
  getAccessToken(tenantId: string, integrationId: string): Promise<string | null>;
}

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;
const text = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v.trim() : undefined;
const scalarText = (v: unknown): string | undefined => typeof v === "number" && Number.isSafeInteger(v) ? String(v) : text(v);
const number = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000_000 ? n : undefined;
};

// ISO 4217 currencies do not all use two fractional digits.
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
  "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"
]);
const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"
]);
function minor(v: unknown, currency: unknown): number | undefined {
  const n = number(v);
  if (n === undefined) return undefined;
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  const digits = ZERO_DECIMAL_CURRENCIES.has(code) ? 0 :
    THREE_DECIMAL_CURRENCIES.has(code) ? 3 : 2;
  return Math.round(n * (10 ** digits));
}
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
function safeHttps(raw: unknown): string | undefined {
  const value = text(raw);
  if (!value) return undefined;
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.toString() : undefined; }
  catch { return undefined; }
}
function mapProduct(value: unknown, tenantId: string, capturedAtUtc: string): NormalizedCommerceProduct | null {
  const p = object(value);
  if (!p) return null;
  const externalProductId = scalarText(p.id) ?? text(p.sku) ?? text(p.mpn);
  const title = text(p.name);
  const urlObject = object(p.urls);
  const canonicalUrl = safeHttps(urlObject?.customer ?? p.url);
  if (!externalProductId || !title || !canonicalUrl) return null;
  const price = object(p.price);
  const description = text(p.description);
  const brand = text(object(p.brand)?.name);
  const currency = text(price?.currency);
  const priceMinor = minor(price?.amount, currency);
  const images = [
    safeHttps(p.thumbnail), safeHttps(p.main_image),
    ...list(p.images).map(item => safeHttps(object(item)?.url))
  ].filter((v): v is string => v !== undefined);
  const variants: NormalizedCommerceVariant[] = [];
  for (const skuValue of list(p.skus)) {
    const sku = object(skuValue);
    if (!sku) continue;
    const id = scalarText(sku.id) ?? text(sku.sku);
    if (!id) continue;
    const variantPrice = object(sku.price);
    const variantSku = text(sku.sku);
    const barcode = text(sku.barcode);
    const stock = number(sku.stock_quantity);
    const sizeLabel = text(sku.name);
    const variantCurrency = text(variantPrice?.currency);
    const variantPriceMinor = minor(variantPrice?.amount, variantCurrency);
    variants.push({
      externalId: id,
      ...(variantSku !== undefined ? { sku: variantSku } : {}),
      ...(barcode !== undefined ? { barcode } : {}),
      ...(stock !== undefined ? { availability: stock > 0 ? "in_stock" as const : "out_of_stock" as const } : {}),
      ...(sizeLabel !== undefined ? { sizeLabel } : {}),
      ...(variantPriceMinor !== undefined ? { priceMinor: variantPriceMinor } : {}),
      ...(variantCurrency !== undefined ? { currency: variantCurrency } : {})
    });
  }
  return {
    tenantId, providerKey: "salla", externalProductId, canonicalUrl, title,
    ...(description !== undefined ? { description } : {}),
    ...(brand !== undefined ? { brand } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(priceMinor !== undefined ? { priceMinor } : {}),
    imageUrls: [...new Set(images)], variants,
    sourceType: "official_api", sourceCapturedAtUtc: capturedAtUtc,
    sourceContentSha256: createHash("sha256").update(JSON.stringify(p), "utf8").digest("hex")
  };
}

/** Salla Merchant API adapter. Tokens are resolved at runtime and never stored in this adapter. */
export class SallaCommerceCatalogAdapter implements CommerceCatalogAdapter {
  readonly descriptor: CommerceProviderDescriptor;
  constructor(
    private readonly api: SallaMerchantApi,
    private readonly tokens: SallaAccessTokenProvider,
    merchantHosts: readonly string[]
  ) {
    if (merchantHosts.length === 0 || merchantHosts.some(host => !/^(?:[a-z0-9-]+\\.)*[a-z0-9-]+$/i.test(host))) {
      throw new Error("INVALID_SALLA_MERCHANT_HOSTS");
    }
    this.descriptor = {
      providerKey: "salla", displayName: "Salla Merchant API",
      websiteHosts: [...new Set([...merchantHosts.map(h => h.toLowerCase()), "salla.sa"])],
      regions: ["SA", "GCC"], sourceTypes: ["official_api"],
      capabilities: ["catalog_read", "variants_read", "price_read", "media_read", "webhooks"],
      implementationStatus: "adapter_available"
    };
  }
  validateSourceUrl(url: URL): boolean {
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      this.descriptor.websiteHosts.includes(url.hostname.toLowerCase());
  }
  async importPage(request: CommerceCatalogImportRequest): Promise<CommerceCatalogImportPage> {
    let source: URL;
    try { source = new URL(request.sourceUrl); } catch { throw new Error("UNTRUSTED_SALLA_STORE_URL"); }
    if (!this.validateSourceUrl(source)) throw new Error("UNTRUSTED_SALLA_STORE_URL");
    const page = request.cursor === undefined ? 1 : Number(request.cursor);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new Error("INVALID_SALLA_PAGE_CURSOR");
    const token = await this.tokens.getAccessToken(request.tenantId, request.integrationId);
    if (!token || token.length > 10_000 || /\\s/.test(token)) throw new Error("SALLA_ACCESS_TOKEN_UNAVAILABLE");
    const response = await this.api.listProducts(token, page, 50);
    if (response.success !== true || !Array.isArray(response.data)) throw new Error("SALLA_PRODUCTS_API_INVALID_RESPONSE");
    const currentPage = response.pagination?.currentPage ?? page;
    const totalPages = response.pagination?.totalPages;
    if (!Number.isSafeInteger(currentPage) || currentPage !== page ||
        (totalPages !== undefined && (!Number.isSafeInteger(totalPages) || totalPages < currentPage))) {
      throw new Error("SALLA_PRODUCTS_API_INVALID_PAGINATION");
    }
    const capturedAtUtc = new Date().toISOString();
    const products = response.data.map(p => mapProduct(p, request.tenantId, capturedAtUtc))
      .filter((p): p is NormalizedCommerceProduct => p !== null);
    const completed = totalPages === undefined ? response.pagination?.links?.next == null : currentPage >= totalPages;
    return {
      products, completed, capturedAtUtc,
      ...(!completed ? { nextCursor: String(currentPage + 1) } : {})
    };
  }
}
