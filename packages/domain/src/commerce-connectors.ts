/**
 * Universal commerce connector contracts.
 * Network access and provider parsing are injected by trusted adapters.
 */
export const COMMERCE_SOURCE_TYPES = ["official_api", "merchant_feed", "structured_data", "html_page", "manual"] as const;
export type CommerceSourceType = (typeof COMMERCE_SOURCE_TYPES)[number];
export type CommerceCapability = "catalog_read" | "variants_read" | "inventory_read" | "price_read" | "media_read" | "size_chart_read" | "webhooks" | "orders_write";

export interface CommerceProviderDescriptor {
  providerKey: string;
  displayName: string;
  websiteHosts: readonly string[];
  regions: readonly string[];
  sourceTypes: readonly CommerceSourceType[];
  capabilities: readonly CommerceCapability[];
  implementationStatus: "planned" | "adapter_available" | "verified";
}
export interface NormalizedCommerceVariant {
  externalId: string; sku?: string; sizeLabel?: string; colorLabel?: string;
  barcode?: string; priceMinor?: number; currency?: string;
  availability?: "in_stock" | "out_of_stock" | "preorder" | "unknown";
}
export interface NormalizedCommerceProduct {
  tenantId: string; providerKey: string; externalProductId: string;
  canonicalUrl: string; title: string; description?: string; brand?: string;
  currency?: string; priceMinor?: number; imageUrls: readonly string[];
  variants: readonly NormalizedCommerceVariant[]; sizeChartUrl?: string;
  sourceType: CommerceSourceType; sourceCapturedAtUtc: string; sourceContentSha256: string;
}
export interface CommerceCatalogImportRequest {
  tenantId: string; integrationId: string; sourceUrl: string;
  cursor?: string; updatedSinceUtc?: string;
}
export interface CommerceCatalogImportPage {
  products: readonly NormalizedCommerceProduct[]; nextCursor?: string;
  completed: boolean; capturedAtUtc: string;
}
export interface CommerceCatalogAdapter {
  readonly descriptor: CommerceProviderDescriptor;
  validateSourceUrl(url: URL): boolean;
  importPage(request: CommerceCatalogImportRequest): Promise<CommerceCatalogImportPage>;
}

/** Exact-host matching: subdomains are not implicitly trusted. */
export function hostMatchesAllowlist(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some(allowed => host === allowed.toLowerCase());
}

export class CommerceConnectorRegistry {
  private readonly adapters = new Map<string, CommerceCatalogAdapter>();
  register(adapter: CommerceCatalogAdapter): void {
    const key = adapter.descriptor.providerKey.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(key) || this.adapters.has(key) ||
        adapter.descriptor.websiteHosts.length === 0 ||
        adapter.descriptor.websiteHosts.some(host => !/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/.test(host))) {
      throw new Error("INVALID_OR_DUPLICATE_COMMERCE_ADAPTER");
    }
    this.adapters.set(key, adapter);
  }
  get(providerKey: string): CommerceCatalogAdapter | null {
    return this.adapters.get(providerKey.toLowerCase()) ?? null;
  }
  list(): CommerceProviderDescriptor[] {
    return [...this.adapters.values()].map(adapter => adapter.descriptor);
  }
  resolveForUrl(rawUrl: string): CommerceCatalogAdapter | null {
    let url: URL;
    try { url = new URL(rawUrl); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    for (const adapter of this.adapters.values()) {
      if (adapter.validateSourceUrl(url)) return adapter;
    }
    return null;
  }
}

/** Initial directory entry only; this does not claim a live Centrepoint adapter. */
export const CENTREPOINT_SA_PROVIDER: CommerceProviderDescriptor = {
  providerKey: "centrepoint-sa",
  displayName: "Centrepoint Saudi Arabia",
  websiteHosts: ["www.centrepointstores.com", "centrepointstores.com"],
  regions: ["SA"],
  sourceTypes: ["official_api", "merchant_feed", "structured_data", "html_page"],
  capabilities: ["catalog_read", "variants_read", "price_read", "media_read", "size_chart_read"],
  implementationStatus: "planned"
};

export function validateNormalizedCommerceProduct(product: NormalizedCommerceProduct): boolean {
  const nonEmpty = (value: unknown, max = 500): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= max;
  let url: URL;
  try { url = new URL(product.canonicalUrl); } catch { return false; }
  if (!nonEmpty(product.tenantId, 160) || !nonEmpty(product.providerKey, 80) ||
      !nonEmpty(product.externalProductId, 200) || !nonEmpty(product.title, 500) ||
      url.protocol !== "https:" || url.username || url.password ||
      !COMMERCE_SOURCE_TYPES.includes(product.sourceType) ||
      !Number.isFinite(Date.parse(product.sourceCapturedAtUtc)) ||
      !/^[a-f0-9]{64}$/.test(product.sourceContentSha256) ||
      !Array.isArray(product.imageUrls) || product.imageUrls.length > 30 ||
      !Array.isArray(product.variants) || product.variants.length > 500) return false;
  if (product.priceMinor !== undefined &&
      (!Number.isSafeInteger(product.priceMinor) || product.priceMinor < 0)) return false;
  if (product.currency !== undefined && !/^[A-Z]{3}$/.test(product.currency)) return false;
  if (product.imageUrls.some(image => {
    try { return new URL(image).protocol !== "https:"; } catch { return true; }
  })) return false;
  return product.variants.every(variant =>
    nonEmpty(variant.externalId, 200) &&
    (variant.priceMinor === undefined || (Number.isSafeInteger(variant.priceMinor) && variant.priceMinor >= 0)) &&
    (variant.currency === undefined || /^[A-Z]{3}$/.test(variant.currency))
  );
}

/** Validate that an imported product belongs to the provider being used.
 * Product images may use a CDN host, but the canonical product page and size-chart
 * source must remain on the provider's explicitly allowlisted hosts.
 */
export function validateCommerceProductForProvider(
  product: NormalizedCommerceProduct,
  provider: CommerceProviderDescriptor
): boolean {
  if (product.providerKey.toLowerCase() !== provider.providerKey.toLowerCase()) return false;
  let canonical: URL;
  try { canonical = new URL(product.canonicalUrl); } catch { return false; }
  if (canonical.protocol !== "https:" || !hostMatchesAllowlist(canonical.hostname, provider.websiteHosts)) {
    return false;
  }
  if (product.sizeChartUrl !== undefined) {
    let chart: URL;
    try { chart = new URL(product.sizeChartUrl); } catch { return false; }
    if (chart.protocol !== "https:" || !hostMatchesAllowlist(chart.hostname, provider.websiteHosts)) return false;
  }
  return validateNormalizedCommerceProduct(product);
}
