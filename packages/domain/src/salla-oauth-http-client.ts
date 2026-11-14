import type { SallaOAuthRefreshClient } from "./salla-oauth-token-manager.js";

export const SALLA_OAUTH_BASE = "https://accounts.salla.sa/oauth2";

export type SallaOAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SallaOAuthHttpClientOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: SallaOAuthFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface SallaOAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: "bearer";
  scope?: string;
}

function validCredential(value: string, max = 4096): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n]/.test(value);
}

function parseExpiry(value: Record<string, unknown>): number {
  if (Number.isSafeInteger(value.expires_in) && (value.expires_in as number) > 0) {
    return value.expires_in as number;
  }
  // Salla's app authorization event also documents "expires" as a Unix timestamp.
  if (Number.isSafeInteger(value.expires) && (value.expires as number) > 0) {
    const seconds = (value.expires as number) - Math.floor(Date.now() / 1000);
    if (seconds > 0 && seconds <= 60 * 60 * 24 * 31) return seconds;
  }
  throw new Error("SALLA_OAUTH_INVALID_EXPIRY");
}

/** Fixed-origin OAuth transport. Credentials and authorization codes are never accepted from URLs. */
export class SallaOAuthHttpClient implements SallaOAuthRefreshClient {
  private readonly fetchImpl: SallaOAuthFetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: SallaOAuthHttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 65_536;
    let redirect: URL;
    try { redirect = new URL(options.redirectUri); } catch { throw new Error("INVALID_SALLA_OAUTH_CONFIGURATION"); }
    if (!validCredential(options.clientId) || !validCredential(options.clientSecret) ||
        redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash ||
        !Number.isInteger(this.timeoutMs) || this.timeoutMs < 250 || this.timeoutMs > 30_000 ||
        !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1_024 ||
        this.maxResponseBytes > 262_144) {
      throw new Error("INVALID_SALLA_OAUTH_CONFIGURATION");
    }
  }

  buildAuthorizationUrl(input: { state: string; scopes: readonly string[] }): string {
    if (!validCredential(input.state, 256) || !/^[A-Za-z0-9_-]{32,256}$/.test(input.state) ||
        !Array.isArray(input.scopes) || input.scopes.length === 0 ||
        input.scopes.length > 30 ||
        input.scopes.some(scope => !/^[a-z][a-z0-9_.]{1,80}$/.test(scope))) {
      throw new Error("INVALID_SALLA_OAUTH_AUTHORIZATION_REQUEST");
    }
    const scopes = [...new Set([...input.scopes, "offline_access"])];
    const url = new URL(`${SALLA_OAUTH_BASE}/auth`);
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", input.state);
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string): Promise<SallaOAuthTokenResponse> {
    if (!validCredential(code, 4096)) throw new Error("INVALID_SALLA_OAUTH_CODE");
    return this.requestToken({
      grant_type: "authorization_code",
      code,
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      redirect_uri: this.options.redirectUri
    });
  }

  async refresh(refreshToken: string): Promise<SallaOAuthTokenResponse> {
    if (!validCredential(refreshToken, 10_000)) throw new Error("INVALID_SALLA_REFRESH_TOKEN");
    return this.requestToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      redirect_uri: this.options.redirectUri
    });
  }

  private async requestToken(fields: Record<string, string>): Promise<SallaOAuthTokenResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${SALLA_OAUTH_BASE}/token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams(fields).toString(),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new Error("SALLA_OAUTH_ENDPOINT_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(response.status === 429 ? "SALLA_OAUTH_RATE_LIMITED" : "SALLA_OAUTH_TOKEN_REQUEST_FAILED");
    }
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("SALLA_OAUTH_INVALID_CONTENT_TYPE");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("SALLA_OAUTH_RESPONSE_TOO_LARGE");
    }
    if (!response.body) throw new Error("SALLA_OAUTH_EMPTY_RESPONSE");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > this.maxResponseBytes) {
          await reader.cancel();
          throw new Error("SALLA_OAUTH_RESPONSE_TOO_LARGE");
        }
        chunks.push(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof Error && error.message === "SALLA_OAUTH_RESPONSE_TOO_LARGE") throw error;
      throw new Error("SALLA_OAUTH_RESPONSE_READ_FAILED");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error("SALLA_OAUTH_INVALID_JSON"); }
    const root = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
    const data = root && root.data !== null && typeof root.data === "object" && !Array.isArray(root.data)
      ? root.data as Record<string, unknown> : root;
    if (!data || typeof data.access_token !== "string" || !validCredential(data.access_token, 10_000) ||
        typeof data.refresh_token !== "string" || !validCredential(data.refresh_token, 10_000)) {
      throw new Error("SALLA_OAUTH_INVALID_TOKEN_RESPONSE");
    }
    const expiresIn = parseExpiry(data);
    const tokenType = typeof data.token_type === "string" ? data.token_type.toLowerCase() : "bearer";
    if (tokenType !== "bearer") throw new Error("SALLA_OAUTH_INVALID_TOKEN_TYPE");
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: expiresIn,
      token_type: "bearer",
      ...(typeof data.scope === "string" ? { scope: data.scope } : {})
    };
  }
}
