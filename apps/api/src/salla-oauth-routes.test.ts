import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { Actor } from "../../../packages/domain/src/authorization.js";
import { IntegrationHub, InMemoryIntegrationRegistryStore } from "../../../packages/domain/src/integration-hub.js";

const owner: Actor = {
  id: "owner-1", role: "merchant_owner", active: true,
  grants: [{ resource: "merchant.integration", actions: ["update"], scope: { merchantId: "merchant-1" } }]
};
const now = "2026-11-09T08:00:00.000Z";

async function integrationHub() {
  const hub = new IntegrationHub(new InMemoryIntegrationRegistryStore());
  await hub.register({
    id: "salla-main", tenantId: "merchant-1", family: "commerce", providerKey: "salla",
    displayName: "Salla", status: "pending", capabilities: ["catalog_read"],
    createdAtUtc: now, updatedAtUtc: now
  });
  return hub;
}

describe("Salla OAuth API routes", () => {
  it("fails closed when OAuth flow is not configured", async () => {
    const app = buildApp({ resolveActor: async () => owner, integrationHub: await integrationHub() });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/integrations/salla-main/salla/oauth/start"
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "salla_oauth_not_configured" });
    } finally { await app.close(); }
  });

  it("requires an authenticated merchant administrator before starting OAuth", async () => {
    const app = buildApp({ integrationHub: await integrationHub(), sallaOAuthFlow: {
      async begin() { throw new Error("must not be called"); },
      async complete() { throw new Error("must not be called"); }
    } });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/integrations/salla-main/salla/oauth/start"
      });
      expect(response.statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("starts OAuth only for a registered Salla commerce integration and validates callback state shape", async () => {
    let begins = 0;
    let completed = 0;
    const app = buildApp({
      resolveActor: async () => owner,
      integrationHub: await integrationHub(),
      sallaOAuthFlow: {
        async begin(input) {
          begins++;
          expect(input).toEqual({ tenantId: "merchant-1", integrationId: "salla-main" });
          return { authorizationUrl: "https://accounts.salla.sa/oauth2/auth?state=" + "a".repeat(43) };
        },
        async complete(input) {
          completed++;
          expect(input).toEqual({ code: "one-time-code", state: "b".repeat(43) });
          return { tenantId: "merchant-1", integrationId: "salla-main" };
        }
      }
    });
    await app.ready();
    try {
      const started = await app.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/integrations/salla-main/salla/oauth/start"
      });
      expect(started.statusCode).toBe(200);
      expect(started.json().authorizationUrl).toContain("accounts.salla.sa");
      expect(begins).toBe(1);

      const invalid = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/salla/oauth/callback?code=one-time-code&state=short"
      });
      expect(invalid.statusCode).toBe(400);
      expect(completed).toBe(0);

      const callback = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/salla/oauth/callback?code=one-time-code&state=" + "b".repeat(43)
      });
      expect(callback.statusCode).toBe(200);
      expect(callback.json()).toEqual({ outcome: "authorized", integrationId: "salla-main" });
      expect(completed).toBe(1);
    } finally { await app.close(); }
  });
});
