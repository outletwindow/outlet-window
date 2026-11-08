/** Salla OAuth token lifecycle contracts. Secret values are opaque and stored only by an injected vault. */
export interface SallaOAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAtUtc: string;
}
export interface SallaOAuthTokenVault {
  read(tenantId: string, integrationId: string): Promise<SallaOAuthTokenSet | null>;
  writeAtomically(tenantId: string, integrationId: string, tokens: SallaOAuthTokenSet): Promise<void>;
}
export interface SallaOAuthRefreshClient {
  refresh(refreshToken: string): Promise<{
    access_token: string; refresh_token: string; expires_in: number;
  }>;
}
export interface SallaRefreshLock {
  /** Must be a distributed lock in production, not a process-local mutex. */
  withLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
}
function validTokenSet(value: SallaOAuthTokenSet): boolean {
  return typeof value.accessToken === "string" && value.accessToken.length > 0 &&
    typeof value.refreshToken === "string" && value.refreshToken.length > 0 &&
    Number.isFinite(Date.parse(value.expiresAtUtc)) && value.expiresAtUtc.endsWith("Z");
}

/** Refresh tokens are single-use; lock, re-read, refresh once, and atomically rotate both tokens. */
export class SallaOAuthTokenManager {
  constructor(
    private readonly vault: SallaOAuthTokenVault,
    private readonly client: SallaOAuthRefreshClient,
    private readonly lock: SallaRefreshLock,
    private readonly now: () => Date = () => new Date(),
    private readonly refreshBeforeExpirySeconds = 300
  ) {
    if (!Number.isInteger(refreshBeforeExpirySeconds) || refreshBeforeExpirySeconds < 0 ||
        refreshBeforeExpirySeconds > 3600) throw new Error("INVALID_SALLA_REFRESH_WINDOW");
  }

  async getAccessToken(tenantId: string, integrationId: string): Promise<string | null> {
    if (!tenantId.trim() || !integrationId.trim()) throw new Error("INVALID_SALLA_TOKEN_SCOPE");
    const key = tenantId + ":" + integrationId;
    const current = await this.vault.read(tenantId, integrationId);
    if (!current || !validTokenSet(current)) return null;
    if (Date.parse(current.expiresAtUtc) - this.now().getTime() > this.refreshBeforeExpirySeconds * 1000) {
      return current.accessToken;
    }
    return this.lock.withLock(key, async () => {
      // Another worker may have rotated the single-use refresh token while we waited.
      const latest = await this.vault.read(tenantId, integrationId);
      if (!latest || !validTokenSet(latest)) return null;
      if (Date.parse(latest.expiresAtUtc) - this.now().getTime() > this.refreshBeforeExpirySeconds * 1000) {
        return latest.accessToken;
      }
      const refreshed = await this.client.refresh(latest.refreshToken);
      if (!refreshed.access_token || !refreshed.refresh_token ||
          !Number.isSafeInteger(refreshed.expires_in) || refreshed.expires_in <= 0 ||
          refreshed.expires_in > 60 * 60 * 24 * 31) {
        throw new Error("INVALID_SALLA_REFRESH_RESPONSE");
      }
      const next: SallaOAuthTokenSet = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAtUtc: new Date(this.now().getTime() + refreshed.expires_in * 1000).toISOString()
      };
      await this.vault.writeAtomically(tenantId, integrationId, next);
      return next.accessToken;
    });
  }
}
