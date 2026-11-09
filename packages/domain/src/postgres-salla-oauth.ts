import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PostgresClient, PostgresPool, PostgresQueryable } from "./postgres-iam-store.js";
import { SallaOAuthTokenManager, type SallaOAuthTokenSet, type SallaOAuthTokenVault, type SallaRefreshLock } from "./salla-oauth-token-manager.js";
import type { SallaOAuthHttpClient, SallaOAuthTokenResponse } from "./salla-oauth-http-client.js";
import type { SallaOAuthFlow } from "../../../apps/api/src/app.js";

export interface SallaOAuthCodeClient extends SallaOAuthHttpClient {
  buildAuthorizationUrl(input: { state: string; scopes: readonly string[] }): string;
  exchangeAuthorizationCode(code: string): Promise<SallaOAuthTokenResponse>;
}

function stateDigest(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

/** One-time OAuth state persisted as a digest and consumed atomically. */
export class PostgresSallaOAuthStateStore {
  constructor(private readonly db: PostgresQueryable, private readonly now: () => Date = () => new Date()) {}

  async issue(input: { state: string; tenantId: string; integrationId: string; ttlSeconds?: number }): Promise<void> {
    const ttl = input.ttlSeconds ?? 600;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 900 ||
        !input.tenantId.trim() || !input.integrationId.trim()) throw new Error("INVALID_SALLA_OAUTH_STATE");
    await this.db.query(
      "INSERT INTO salla_oauth_states (state_sha256, tenant_id, integration_id, expires_at) VALUES ($1,$2,$3,$4)",
      [stateDigest(input.state), input.tenantId, input.integrationId,
        new Date(this.now().getTime() + ttl * 1000).toISOString()]
    );
  }

  async consume(state: string): Promise<{ tenantId: string; integrationId: string } | null> {
    const result = await this.db.query<{ tenant_id: string; integration_id: string }>(
      "DELETE FROM salla_oauth_states WHERE state_sha256 = $1 AND expires_at > $2 RETURNING tenant_id, integration_id",
      [stateDigest(state), this.now().toISOString()]
    );
    const row = result.rows[0];
    return row ? { tenantId: row.tenant_id, integrationId: row.integration_id } : null;
  }
}

/** AES-256-GCM encrypted PostgreSQL token vault. The encryption key is supplied by the secret manager. */
export class PostgresSallaOAuthTokenVault implements SallaOAuthTokenVault {
  private readonly key: Buffer;
  constructor(private readonly db: PostgresQueryable, keyBase64: string) {
    const key = Buffer.from(keyBase64, "base64");
    if (key.length !== 32 || key.toString("base64") !== keyBase64) throw new Error("INVALID_SALLA_TOKEN_ENCRYPTION_KEY");
    this.key = key;
  }

  private encrypt(tokens: SallaOAuthTokenSet): { iv: string; tag: string; ciphertext: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }

  private decrypt(row: { iv: string; tag: string; ciphertext: string }): SallaOAuthTokenSet {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.iv, "base64"));
      decipher.setAuthTag(Buffer.from(row.tag, "base64"));
      const raw = Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
      const parsed = JSON.parse(raw) as SallaOAuthTokenSet;
      if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string" ||
          typeof parsed.expiresAtUtc !== "string" || !Number.isFinite(Date.parse(parsed.expiresAtUtc))) {
        throw new Error("invalid");
      }
      return parsed;
    } catch { throw new Error("SALLA_TOKEN_VAULT_DECRYPTION_FAILED"); }
  }

  async read(tenantId: string, integrationId: string): Promise<SallaOAuthTokenSet | null> {
    const result = await this.db.query<{ iv: string; auth_tag: string; ciphertext: string }>(
      "SELECT iv, auth_tag, ciphertext FROM salla_oauth_tokens WHERE tenant_id = $1 AND integration_id = $2",
      [tenantId, integrationId]
    );
    const row = result.rows[0];
    return row ? this.decrypt({ iv: row.iv, tag: row.auth_tag, ciphertext: row.ciphertext }) : null;
  }

  async writeAtomically(tenantId: string, integrationId: string, tokens: SallaOAuthTokenSet): Promise<void> {
    const encrypted = this.encrypt(tokens);
    await this.db.query(
      `INSERT INTO salla_oauth_tokens (tenant_id, integration_id, iv, auth_tag, ciphertext, expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (tenant_id, integration_id) DO UPDATE SET
       iv=EXCLUDED.iv, auth_tag=EXCLUDED.auth_tag, ciphertext=EXCLUDED.ciphertext,
       expires_at=EXCLUDED.expires_at, updated_at=now()`,
      [tenantId, integrationId, encrypted.iv, encrypted.tag, encrypted.ciphertext, tokens.expiresAtUtc]
    );
  }
}

/** PostgreSQL session advisory lock; serializes refreshes across API instances. */
export class PostgresSallaRefreshLock implements SallaRefreshLock {
  constructor(private readonly pool: PostgresPool) {}
  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const client: PostgresClient = await this.pool.connect();
    const lockId = createHash("sha256").update(key, "utf8").digest().readInt32BE(0);
    let locked = false;
    try {
      await client.query("SELECT pg_advisory_lock($1)", [lockId]);
      locked = true;
      return await operation();
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
      client.release();
    }
  }
}

export class SallaOAuthFlowService implements SallaOAuthFlow {
  private readonly tokens: SallaOAuthTokenManager;
  constructor(
    private readonly states: PostgresSallaOAuthStateStore,
    private readonly vault: PostgresSallaOAuthTokenVault,
    private readonly client: SallaOAuthCodeClient,
    lock: SallaRefreshLock,
    private readonly scopes: readonly string[] = ["offline_access", "products.read"]
  ) {
    this.tokens = new SallaOAuthTokenManager(vault, client, lock);
  }

  async begin(input: { tenantId: string; integrationId: string }): Promise<{ authorizationUrl: string }> {
    const state = randomBytes(32).toString("base64url");
    await this.states.issue({ ...input, state, ttlSeconds: 600 });
    return { authorizationUrl: this.client.buildAuthorizationUrl({ state, scopes: this.scopes }) };
  }

  async complete(input: { code: string; state: string }): Promise<{ tenantId: string; integrationId: string }> {
    const binding = await this.states.consume(input.state);
    if (!binding) throw new Error("SALLA_OAUTH_STATE_INVALID_OR_EXPIRED");
    const response = await this.client.exchangeAuthorizationCode(input.code);
    await this.vault.writeAtomically(binding.tenantId, binding.integrationId, {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAtUtc: new Date(Date.now() + response.expires_in * 1000).toISOString()
    });
    return binding;
  }

  getAccessToken(tenantId: string, integrationId: string): Promise<string | null> {
    return this.tokens.getAccessToken(tenantId, integrationId);
  }
}
