import { describe, expect, it } from "vitest";
import type { PostgresQueryable, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresSallaOAuthStateStore, PostgresSallaOAuthTokenVault } from "./postgres-salla-oauth.js";

class FakeDb implements PostgresQueryable {
  state: { hash: string; tenant: string; integration: string; expires: string } | null = null;
  token: { iv: string; auth_tag: string; ciphertext: string } | null = null;
  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    if (sql.startsWith("INSERT INTO salla_oauth_states")) {
      this.state = { hash: String(values[0]), tenant: String(values[1]), integration: String(values[2]), expires: String(values[3]) };
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM salla_oauth_states")) {
      if (!this.state || this.state.hash !== values[0] || Date.parse(this.state.expires) <= Date.parse(String(values[1]))) {
        return { rows: [], rowCount: 0 };
      }
      const row = { tenant_id: this.state.tenant, integration_id: this.state.integration } as Row;
      this.state = null;
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO salla_oauth_tokens")) {
      this.token = { iv: String(values[2]), auth_tag: String(values[3]), ciphertext: String(values[4]) };
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT iv, auth_tag, ciphertext FROM salla_oauth_tokens")) {
      return { rows: (this.token ? [this.token as Row] : []), rowCount: this.token ? 1 : 0 };
    }
    throw new Error("UNEXPECTED_SQL");
  }
}
const key = Buffer.alloc(32, 7).toString("base64");

describe("PostgreSQL Salla OAuth persistence", () => {
  it("stores only a state digest and consumes it once", async () => {
    const db = new FakeDb();
    const store = new PostgresSallaOAuthStateStore(db, () => new Date("2026-11-09T10:00:00.000Z"));
    const state = "s".repeat(43);
    await store.issue({ state, tenantId: "tenant-1", integrationId: "salla-1" });
    expect(db.state?.hash).not.toBe(state);
    expect(db.state?.hash).toMatch(/^[a-f0-9]{64}$/);
    await expect(store.consume(state)).resolves.toEqual({ tenantId: "tenant-1", integrationId: "salla-1" });
    await expect(store.consume(state)).resolves.toBeNull();
  });

  it("encrypts token material at rest and decrypts it for the scoped integration", async () => {
    const db = new FakeDb();
    const vault = new PostgresSallaOAuthTokenVault(db, key);
    const tokens = {
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      expiresAtUtc: "2026-11-09T11:00:00.000Z"
    };
    await vault.writeAtomically("tenant-1", "salla-1", tokens);
    expect(db.token?.ciphertext).not.toContain("access-token-secret");
    expect(db.token?.ciphertext).not.toContain("refresh-token-secret");
    await expect(vault.read("tenant-1", "salla-1")).resolves.toEqual(tokens);
    await expect(vault.read("tenant-2", "salla-1")).resolves.toBeNull();
  });

  it("rejects malformed encryption keys and tampered ciphertext", async () => {
    expect(() => new PostgresSallaOAuthTokenVault(new FakeDb(), "not-a-key")).toThrow("INVALID_SALLA_TOKEN_ENCRYPTION_KEY");
    const db = new FakeDb();
    const vault = new PostgresSallaOAuthTokenVault(db, key);
    await vault.writeAtomically("tenant-1", "salla-1", {
      accessToken: "a", refreshToken: "r", expiresAtUtc: "2026-11-09T11:00:00.000Z"
    });
    db.token!.ciphertext = Buffer.from("tampered").toString("base64");
    await expect(vault.read("tenant-1", "salla-1")).rejects.toThrow("SALLA_TOKEN_VAULT_DECRYPTION_FAILED");
  });
});
