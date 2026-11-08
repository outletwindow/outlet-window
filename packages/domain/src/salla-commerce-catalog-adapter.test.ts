import { describe, expect, it } from "vitest";
import { SallaCommerceCatalogAdapter, type SallaMerchantApi, type SallaAccessTokenProvider } from "./salla-commerce-catalog-adapter.js";

const request = { tenantId: "tenant-1", integrationId: "salla-1", sourceUrl: "https://my-store.salla.sa" };
const products = [{
  id: 1001, name: "T-Shirt", sku: "TS-01",
  urls: { customer: "https://salla.sa/my-store/t-shirt/p1001" },
  price: { amount: 99.95, currency: "SAR" },
  thumbnail: "https://cdn.example.com/tshirt.jpg",
  images: [{ url: "https://cdn.example.com/tshirt-2.jpg" }],
  skus: [
    { id: 5001, sku: "TS-S", name: "Small", stock_quantity: 3, price: { amount: 99.95, currency: "SAR" }, barcode: "123" },
    { id: 5002, sku: "TS-M", name: "Medium", stock_quantity: 0 }
  ]
}];

function makeAdapter(response: { success?: boolean; data?: unknown; pagination?: { currentPage?: number; totalPages?: number; links?: { next?: string | null } } }) {
  const calls: Array<{ token: string; page: number; perPage: number }> = [];
  const api: SallaMerchantApi = { async listProducts(token, page, perPage) { calls.push({ token, page, perPage }); return response; } };
  const tokens: SallaAccessTokenProvider = { async getAccessToken(tenantId, integrationId) {
    expect(tenantId).toBe("tenant-1"); expect(integrationId).toBe("salla-1"); return "opaque-access-token";
  }};
  return { adapter: new SallaCommerceCatalogAdapter(api, tokens, ["my-store.salla.sa"]), calls };
}

describe("Salla Commerce Catalog Adapter", () => {
  it("maps products, currency, images, SKUs and stock signals", async () => {
    const { adapter, calls } = makeAdapter({ success: true, data: products, pagination: { currentPage: 1, totalPages: 1 } });
    const result = await adapter.importPage(request);
    expect(calls).toEqual([{ token: "opaque-access-token", page: 1, perPage: 50 }]);
    expect(result).toMatchObject({ completed: true, products: [{ externalProductId: "1001", title: "T-Shirt", currency: "SAR", priceMinor: 9995, variants: [{ externalId: "5001", sku: "TS-S", availability: "in_stock" }, { externalId: "5002", availability: "out_of_stock" }] }] });
    expect(result.products[0]?.sourceContentSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("paginates using numeric cursors and stops at total pages", async () => {
    const { adapter, calls } = makeAdapter({ success: true, data: products, pagination: { currentPage: 2, totalPages: 3 } });
    const result = await adapter.importPage({ ...request, cursor: "2" });
    expect(calls[0]?.page).toBe(2);
    expect(result).toMatchObject({ completed: false, nextCursor: "3" });
  });
  it("rejects unknown store domains and invalid cursor values", async () => {
    const { adapter } = makeAdapter({ success: true, data: [], pagination: { currentPage: 1, totalPages: 1 } });
    await expect(adapter.importPage({ ...request, sourceUrl: "https://attacker.example" })).rejects.toThrow("UNTRUSTED_SALLA_STORE_URL");
    await expect(adapter.importPage({ ...request, cursor: "next=evil" })).rejects.toThrow("INVALID_SALLA_PAGE_CURSOR");
  });
  it("fails closed when token is unavailable or API response is invalid", async () => {
    const api: SallaMerchantApi = { async listProducts() { return { success: false, data: [] }; } };
    const noToken: SallaAccessTokenProvider = { async getAccessToken() { return null; } };
    const adapter = new SallaCommerceCatalogAdapter(api, noToken, ["my-store.salla.sa"]);
    await expect(adapter.importPage(request)).rejects.toThrow("SALLA_ACCESS_TOKEN_UNAVAILABLE");
    const { adapter: badResponse } = makeAdapter({ success: false, data: [] });
    await expect(badResponse.importPage(request)).rejects.toThrow("SALLA_PRODUCTS_API_INVALID_RESPONSE");
  });
});
