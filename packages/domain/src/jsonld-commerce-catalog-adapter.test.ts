import { describe, expect, it } from "vitest";
import { CENTREPOINT_SA_PROVIDER } from "./commerce-connectors.js";
import { JsonLdCommerceCatalogAdapter, type SafeMerchantPageFetcher } from "./jsonld-commerce-catalog-adapter.js";

const page = `<!doctype html><html><head><script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"ProductGroup",
  "name":"Everyday Shirt",
  "sku":"SHIRT-100",
  "url":"https://www.centrepointstores.com/sa/en/p/shirt",
  "brand":{"@type":"Brand","name":"Brand A"},
  "image":["https://www.centrepointstores.com/images/shirt.jpg"],
  "offers":{"@type":"Offer","price":"99.95","priceCurrency":"SAR"},
  "hasVariant":[
    {"@type":"Product","sku":"SHIRT-100-S","size":"S","color":"Blue"},
    {"@type":"Product","sku":"SHIRT-100-M","size":"M","color":"Blue"}
  ]
}
</script></head></html>`;

function adapterFor(response: { html: string; finalUrl: string; capturedAtUtc: string }) {
  const fetcher: SafeMerchantPageFetcher = { async fetchHtml() { return response; } };
  return new JsonLdCommerceCatalogAdapter(CENTREPOINT_SA_PROVIDER, fetcher);
}
describe("JSON-LD merchant catalog adapter", () => {
  it("normalizes a product group, offers, images and explicit size variants", async () => {
    const adapter = adapterFor({ html: page, finalUrl: "https://www.centrepointstores.com/sa/en/p/shirt", capturedAtUtc: "2026-11-08T10:00:00.000Z" });
    const result = await adapter.importPage({ tenantId: "tenant-a", integrationId: "int-a", sourceUrl: "https://www.centrepointstores.com/sa/en/p/shirt" });
    expect(result).toMatchObject({ completed: true, products: [{ title: "Everyday Shirt", priceMinor: 9995, currency: "SAR", brand: "Brand A", variants: [{ sizeLabel: "S" }, { sizeLabel: "M" }] }] });
    expect(result.products[0]?.sourceContentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.products[0]?.tenantId).toBe("tenant-a");
  });
  it("does not invent products when JSON-LD is absent or malformed", async () => {
    const adapter = adapterFor({ html: '<script type="application/ld+json">{bad json}</script>', finalUrl: "https://www.centrepointstores.com/p/1", capturedAtUtc: "2026-11-08T10:00:00.000Z" });
    await expect(adapter.importPage({ tenantId: "t", integrationId: "i", sourceUrl: "https://www.centrepointstores.com/p/1" })).resolves.toMatchObject({ products: [] });
  });
  it("rejects an off-domain final redirect", async () => {
    const adapter = adapterFor({ html: page, finalUrl: "https://attacker.example/p/1", capturedAtUtc: "2026-11-08T10:00:00.000Z" });
    await expect(adapter.importPage({ tenantId: "t", integrationId: "i", sourceUrl: "https://www.centrepointstores.com/p/1" })).rejects.toThrow("UNTRUSTED_MERCHANT_REDIRECT");
  });
  it("rejects oversized or invalid source responses", async () => {
    const adapter = adapterFor({ html: "x".repeat(2_000_001), finalUrl: "https://www.centrepointstores.com/p/1", capturedAtUtc: "2026-11-08T10:00:00.000Z" });
    await expect(adapter.importPage({ tenantId: "t", integrationId: "i", sourceUrl: "https://www.centrepointstores.com/p/1" })).rejects.toThrow("INVALID_MERCHANT_PAGE_RESPONSE");
  });
  it("rejects cursor requests instead of silently skipping pages", async () => {
    const adapter = adapterFor({ html: page, finalUrl: "https://www.centrepointstores.com/p/1", capturedAtUtc: "2026-11-08T10:00:00.000Z" });
    await expect(adapter.importPage({ tenantId: "t", integrationId: "i", sourceUrl: "https://www.centrepointstores.com/p/1", cursor: "next" })).rejects.toThrow("DOES_NOT_SUPPORT_CURSORS");
  });
});
