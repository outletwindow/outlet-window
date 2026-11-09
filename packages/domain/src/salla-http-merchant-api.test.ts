import { describe, expect, it, vi } from "vitest";
import { SallaHttpMerchantApi, type SallaFetch } from "./salla-http-merchant-api.js";

function response(body: string, status = 200, headers: Record<string, string> = { "content-type": "application/json" }) {
  return new Response(body, { status, headers });
}
const token = "opaque-token";

describe("SallaHttpMerchantApi", () => {
  it("uses only the fixed HTTPS endpoint and bounded page parameters", async () => {
    const fetchImpl = vi.fn<SallaFetch>().mockResolvedValue(response(JSON.stringify({ success: true, data: [] })));
    const api = new SallaHttpMerchantApi({ fetchImpl });
    await api.listProducts(token, 2, 50);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.salla.dev/admin/v2/products?page=2&per_page=50");
    expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer opaque-token");
  });

  it("rejects invalid token material and page bounds before network access", async () => {
    const fetchImpl = vi.fn<SallaFetch>();
    const api = new SallaHttpMerchantApi({ fetchImpl });
    await expect(api.listProducts("bad token", 1, 50)).rejects.toThrow("SALLA_ACCESS_TOKEN_UNAVAILABLE");
    await expect(api.listProducts(token, 1, 51)).rejects.toThrow("INVALID_SALLA_PRODUCTS_PAGE");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects redirects/network failures without exposing provider response bodies", async () => {
    const fetchImpl = vi.fn<SallaFetch>().mockRejectedValue(new Error("redirect to attacker"));
    const api = new SallaHttpMerchantApi({ fetchImpl });
    await expect(api.listProducts(token, 1, 50)).rejects.toThrow("SALLA_PRODUCTS_API_UNAVAILABLE");
  });

  it("requires JSON and enforces response byte limits", async () => {
    const wrongType = new SallaHttpMerchantApi({ fetchImpl: vi.fn<SallaFetch>().mockResolvedValue(response("{}", 200, { "content-type": "text/html" })) });
    await expect(wrongType.listProducts(token, 1, 50)).rejects.toThrow("SALLA_PRODUCTS_API_INVALID_CONTENT_TYPE");

    const tooLarge = new SallaHttpMerchantApi({
      maxResponseBytes: 1_024,
      fetchImpl: vi.fn<SallaFetch>().mockResolvedValue(response("x".repeat(1_100)))
    });
    await expect(tooLarge.listProducts(token, 1, 50)).rejects.toThrow("SALLA_PRODUCTS_API_RESPONSE_TOO_LARGE");
  });

  it("rejects invalid JSON and non-success responses", async () => {
    const invalidJson = new SallaHttpMerchantApi({ fetchImpl: vi.fn<SallaFetch>().mockResolvedValue(response("{")) });
    await expect(invalidJson.listProducts(token, 1, 50)).rejects.toThrow("SALLA_PRODUCTS_API_INVALID_JSON");
    const failed = new SallaHttpMerchantApi({ fetchImpl: vi.fn<SallaFetch>().mockResolvedValue(response("{}", 503)) });
    await expect(failed.listProducts(token, 1, 50)).rejects.toThrow("SALLA_PRODUCTS_API_REQUEST_FAILED");
  });
});
