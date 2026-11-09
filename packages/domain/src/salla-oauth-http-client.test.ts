import { describe, expect, it, vi } from "vitest";
import { SallaOAuthHttpClient, type SallaOAuthFetch } from "./salla-oauth-http-client.js";

function response(body: string, status = 200, contentType = "application/json") {
  return new Response(body, { status, headers: { "content-type": contentType } });
}
const config = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://api.outletwindow.com/api/v1/integrations/salla/callback"
};
const tokens = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
  token_type: "bearer"
};

describe("SallaOAuthHttpClient", () => {
  it("builds a fixed Salla authorization URL and always requests offline access", () => {
    const client = new SallaOAuthHttpClient(config);
    const url = new URL(client.buildAuthorizationUrl({
      state: "a".repeat(43), scopes: ["products.read", "orders.read"]
    }));
    expect(url.origin + url.pathname).toBe("https://accounts.salla.sa/oauth2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("scope")).toBe("products.read orders.read offline_access");
    expect(url.searchParams.get("state")).toBe("a".repeat(43));
  });

  it("rejects weak state, invalid scopes, and insecure callback URLs", () => {
    const client = new SallaOAuthHttpClient(config);
    expect(() => client.buildAuthorizationUrl({ state: "short", scopes: ["products.read"] })).toThrow("INVALID_SALLA_OAUTH_AUTHORIZATION_REQUEST");
    expect(() => client.buildAuthorizationUrl({ state: "a".repeat(43), scopes: ["*"] })).toThrow("INVALID_SALLA_OAUTH_AUTHORIZATION_REQUEST");
    expect(() => new SallaOAuthHttpClient({ ...config, redirectUri: "http://localhost/callback" })).toThrow("INVALID_SALLA_OAUTH_CONFIGURATION");
  });

  it("exchanges authorization codes using the fixed token endpoint and form encoding", async () => {
    const fetchImpl = vi.fn<SallaOAuthFetch>().mockResolvedValue(response(JSON.stringify(tokens)));
    const client = new SallaOAuthHttpClient({ ...config, fetchImpl });
    const result = await client.exchangeAuthorizationCode("one-time-code");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://accounts.salla.sa/oauth2/token");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("one-time-code");
    expect(body.get("client_secret")).toBe("client-secret");
    expect(result).toMatchObject({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
  });

  it("refreshes with a single-use refresh token and accepts Salla Unix expiry", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const fetchImpl = vi.fn<SallaOAuthFetch>().mockResolvedValue(response(JSON.stringify({
      access_token: "next-access", refresh_token: "next-refresh", expires: expiry, token_type: "bearer"
    })));
    const client = new SallaOAuthHttpClient({ ...config, fetchImpl });
    const result = await client.refresh("current-refresh");
    const body = new URLSearchParams(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("current-refresh");
    expect(result.expires_in).toBeGreaterThan(0);
  });

  it("fails closed on provider errors, invalid JSON, and non-JSON content", async () => {
    const failed = new SallaOAuthHttpClient({ ...config, fetchImpl: vi.fn<SallaOAuthFetch>().mockResolvedValue(response("{}", 401)) });
    await expect(failed.refresh("refresh")).rejects.toThrow("SALLA_OAUTH_TOKEN_REQUEST_FAILED");
    const invalid = new SallaOAuthHttpClient({ ...config, fetchImpl: vi.fn<SallaOAuthFetch>().mockResolvedValue(response("{")) });
    await expect(invalid.refresh("refresh")).rejects.toThrow("SALLA_OAUTH_INVALID_JSON");
    const html = new SallaOAuthHttpClient({ ...config, fetchImpl: vi.fn<SallaOAuthFetch>().mockResolvedValue(response("<html/>", 200, "text/html")) });
    await expect(html.refresh("refresh")).rejects.toThrow("SALLA_OAUTH_INVALID_CONTENT_TYPE");
  });
});
