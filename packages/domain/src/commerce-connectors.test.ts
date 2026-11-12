import { describe, expect, it } from "vitest";
import {
  CENTREPOINT_SA_PROVIDER, CommerceConnectorRegistry, hostMatchesAllowlist,
  validateNormalizedCommerceProduct, validateCommerceProductForProvider, type CommerceCatalogAdapter
} from "./commerce-connectors.js";

const adapter: CommerceCatalogAdapter = {
  descriptor: CENTREPOINT_SA_PROVIDER,
  validateSourceUrl: url => url.protocol === "https:" &&
    hostMatchesAllowlist(url.hostname, CENTREPOINT_SA_PROVIDER.websiteHosts),
  async importPage() { return { products: [], completed: true, capturedAtUtc: "2026-11-08T00:00:00.000Z" }; }
};

describe("universal commerce connectors", () => {
  it("registers providers and resolves only exact allowlisted HTTPS hosts", () => {
    const registry = new CommerceConnectorRegistry();
    registry.register(adapter);
    expect(registry.resolveForUrl("https://www.centrepointstores.com/sa/EN/")).toBe(adapter);
    expect(registry.resolveForUrl("http://www.centrepointstores.com/")).toBeNull();
    expect(registry.resolveForUrl("https://evilcentrepointstores.com/")).toBeNull();
    expect(registry.resolveForUrl("https://www.centrepointstores.com.evil.test/")).toBeNull();
  });
  it("rejects duplicate provider registration", () => {
    const registry = new CommerceConnectorRegistry();
    registry.register(adapter);
    expect(() => registry.register(adapter)).toThrow("INVALID_OR_DUPLICATE_COMMERCE_ADAPTER");
  });
  it("does not implicitly trust subdomains", () => {
    expect(hostMatchesAllowlist("shop.example.com", ["example.com"])).toBe(false);
    expect(hostMatchesAllowlist("example.com", ["example.com"])).toBe(true);
  });
  it("keeps Centrepoint marked planned until a real adapter is verified", () => {
    expect(CENTREPOINT_SA_PROVIDER.implementationStatus).toBe("planned");
  });
  it("validates normalized products without inventing missing data", () => {
    const product = {
      tenantId: "tenant-1", providerKey: "centrepoint-sa", externalProductId: "sku-1",
      canonicalUrl: "https://www.centrepointstores.com/p/item", title: "Shirt",
      imageUrls: ["https://cdn.example.com/item.jpg"], variants: [],
      sourceType: "structured_data" as const, sourceCapturedAtUtc: "2026-11-08T10:00:00.000Z",
      sourceContentSha256: "a".repeat(64)
    };
    expect(validateNormalizedCommerceProduct(product)).toBe(true);
    expect(validateNormalizedCommerceProduct({ ...product, canonicalUrl: "http://example.com" })).toBe(false);
    expect(validateNormalizedCommerceProduct({ ...product, priceMinor: -1 })).toBe(false);
    expect(validateCommerceProductForProvider(product, CENTREPOINT_SA_PROVIDER)).toBe(true);
    expect(validateCommerceProductForProvider({ ...product, providerKey: "other-store" }, CENTREPOINT_SA_PROVIDER)).toBe(false);
    expect(validateCommerceProductForProvider({ ...product, canonicalUrl: "https://fake-shop.example/item" }, CENTREPOINT_SA_PROVIDER)).toBe(false);
    expect(validateCommerceProductForProvider({ ...product, sizeChartUrl: "http://www.centrepointstores.com/size" }, CENTREPOINT_SA_PROVIDER)).toBe(false);
    expect(validateCommerceProductForProvider({ ...product, sizeChartUrl: "https://fake-shop.example/size" }, CENTREPOINT_SA_PROVIDER)).toBe(false);
  });
});
