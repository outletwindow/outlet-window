import { SALLA_ADMIN_API_BASE, type SallaMerchantApi, type SallaProductsResponse } from "./salla-commerce-catalog-adapter.js";

export type SallaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SallaHttpTransportOptions {
  fetchImpl?: SallaFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Hardened, fixed-origin Salla products transport. No caller-controlled URL is accepted. */
export class SallaHttpMerchantApi implements SallaMerchantApi {
  private readonly fetchImpl: SallaFetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: SallaHttpTransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 250 || this.timeoutMs > 30_000 ||
        !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1_024 ||
        this.maxResponseBytes > 5_000_000) {
      throw new Error("INVALID_SALLA_HTTP_LIMITS");
    }
  }

  async listProducts(accessToken: string, page: number, perPage: number): Promise<SallaProductsResponse> {
    if (typeof accessToken !== "string" || accessToken.length === 0 ||
        accessToken.length > 10_000 || /\s/.test(accessToken)) {
      throw new Error("SALLA_ACCESS_TOKEN_UNAVAILABLE");
    }
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000 ||
        !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 50) {
      throw new Error("INVALID_SALLA_PRODUCTS_PAGE");
    }

    const url = new URL(`${SALLA_ADMIN_API_BASE}/products`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new Error("SALLA_PRODUCTS_API_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(response.status === 429 ? "SALLA_PRODUCTS_API_RATE_LIMITED" : "SALLA_PRODUCTS_API_REQUEST_FAILED");
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("SALLA_PRODUCTS_API_INVALID_CONTENT_TYPE");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("SALLA_PRODUCTS_API_RESPONSE_TOO_LARGE");
    }
    if (!response.body) throw new Error("SALLA_PRODUCTS_API_EMPTY_RESPONSE");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxResponseBytes) {
          await reader.cancel();
          throw new Error("SALLA_PRODUCTS_API_RESPONSE_TOO_LARGE");
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof Error && error.message === "SALLA_PRODUCTS_API_RESPONSE_TOO_LARGE") throw error;
      throw new Error("SALLA_PRODUCTS_API_READ_FAILED");
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error("SALLA_PRODUCTS_API_INVALID_JSON"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("SALLA_PRODUCTS_API_INVALID_RESPONSE");
    }
    return parsed as SallaProductsResponse;
  }
}
