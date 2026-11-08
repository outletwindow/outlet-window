import { describe, expect, it } from "vitest";
import { SallaOAuthTokenManager, type SallaOAuthTokenSet } from "./salla-oauth-token-manager.js";

const now = new Date("2026-11-08T10:00:00.000Z");
const initial: SallaOAuthTokenSet = {
  accessToken: "old-access", refreshToken: "single-use-refresh",
  expiresAtUtc
};
function setup(expiresAtUtc = "2026-11-08T10:01:00.000Z") {
  let tokens: SallaOAuthTokenSet | null = { ...initial };
  let refreshCalls = 0;
  let writes = 0;
  const vault = {
    async read() { return tokens ? { ...tokens } : null; },
    async writeAtomically(_tenant: string, _integration: string, next: SallaOAuthTokenSet) { tokens = { ...next }; writes++; }
  };
  const client = {
    async refresh(token: string) {
      refreshCalls++;
      expect(token).toBe("single-use-refresh");
      return { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 };
    }
  };
  const lock = { async withLock<T>(_key: string, operation: () => Promise<T>) { return operation(); } };
  const manager = new SallaOAuthTokenManager(vault, client, lock, () => now, 300);
  return { manager, counts: () => ({ refreshCalls, writes }), getTokens: () => tokens };
}
describe("Salla OAuth token manager", () => {
  it("returns a valid token without refreshing", async () => {
    const { manager, counts } = setup("2026-11-08T10:10:00.000Z");
    expect(await manager.getAccessToken("t1", "i1")).toBe("old-access");
    expect(counts()).toEqual({ refreshCalls: 0, writes: 0 });
  });
  it("rotates access and single-use refresh token atomically near expiry", async () => {
    const { manager, counts, getTokens } = setup();
    expect(await manager.getAccessToken("t1", "i1")).toBe("new-access");
    expect(counts()).toEqual({ refreshCalls: 1, writes: 1 });
    expect(getTokens()).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
  });
  it("does not persist malformed refresh responses", async () => {
    const { manager } = setup();
    const badClient = { async refresh() { return { access_token: "", refresh_token: "x", expires_in: 10 }; } };
    const bad = new SallaOAuthTokenManager(
      { async read() { return { ...initial }; }, async writeAtomically() { throw new Error("must-not-write"); } },
      badClient, { async withLock<T>(_key: string, op: () => Promise<T>) { return op(); } }, () => now, 300
    );
    await expect(bad.getAccessToken("t1", "i1")).rejects.toThrow("INVALID_SALLA_REFRESH_RESPONSE");
    expect(await manager.getAccessToken("t1", "i1")).toBe("new-access");
  });
  it("returns null when no stored token exists", async () => {
    const manager = new SallaOAuthTokenManager(
      { async read() { return null; }, async writeAtomically() {} },
      { async refresh() { throw new Error("must-not-refresh"); } },
      { async withLock<T>(_key: string, op: () => Promise<T>) { return op(); } }, () => now
    );
    expect(await manager.getAccessToken("t1", "i1")).toBeNull();
  });
});
