import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "../../../packages/domain/src/authorization.js";
import {
  InMemoryIntegrationRegistryStore,
  IntegrationHub,
  type IntegrationConnectionVerifier
} from "../../../packages/domain/src/integration-hub.js";
import { buildApp } from "./app.js";

const owner: Actor = {
  id: "owner-1",
  role: "merchant_owner",
  active: true,
  grants: [{
    resource: "merchant.integration",
    actions: ["read", "create", "update"],
    scope: { merchantId: "merchant-1" }
  }]
};

describe("merchant integration registry API", () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function createApp(actor: Actor | null = owner, verifiers: ReadonlyMap<string, IntegrationConnectionVerifier> = new Map()) {
    const hub = new IntegrationHub(new InMemoryIntegrationRegistryStore(), verifiers);
    const app = buildApp({
      resolveActor: async () => actor,
      integrationHub: hub
    });
    apps.push(app);
    return { app, hub };
  }

  it("registers a pending integration using the authenticated merchant scope", async () => {
    const { app } = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/integrations",
      payload: {
        id: "pos-main",
        family: "pos",
        providerKey: "generic-pos",
        displayName: "Main branch POS",
        capabilities: ["catalog.read", "inventory.read", "inventory.read"]
      }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      integration: {
        id: "pos-main",
        tenantId: "merchant-1",
        family: "pos",
        status: "pending",
        capabilities: ["catalog.read", "inventory.read"]
      }
    });
    expect(response.json().integration).not.toHaveProperty("secretReference");
    expect(response.json().integration).not.toHaveProperty("secret");
    const duplicate = await app.inject({
      method: "POST", url: "/api/v1/merchants/merchant-1/integrations",
      payload: {
        id: "pos-main", family: "pos", providerKey: "generic-pos",
        displayName: "Main branch POS", capabilities: ["catalog.read"]
      }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: "integration_already_exists" });
  });

  it("denies cross-merchant registration before writing", async () => {
    const { app, hub } = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-2/integrations",
      payload: {
        id: "pos-main", family: "pos", providerKey: "generic-pos",
        displayName: "Main POS", capabilities: []
      }
    });
    expect(response.statusCode).toBe(403);
    expect(await hub.list("merchant-2")).toEqual([]);
  });

  it("requires an authenticated actor", async () => {
    const { app } = createApp(null);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/merchants/merchant-1/integrations"
    });
    expect(response.statusCode).toBe(401);
  });

  it("verifies a merchant integration only through its configured provider adapter", async () => {
    const verifier = { verify: async () => ({ connected: true }) };
    const { app, hub } = createApp(owner, new Map([["generic-pos", verifier]]));
    const now = "2026-11-08T12:00:00.000Z";
    await hub.register({
      id: "pos-main", tenantId: "merchant-1", family: "pos",
      providerKey: "generic-pos", displayName: "Main POS", status: "pending",
      capabilities: ["inventory.read"], createdAtUtc: now, updatedAtUtc: now
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/integrations/pos-main/verify"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: "connected", status: "connected", integrationId: "pos-main"
    });
    expect((await hub.list("merchant-1"))[0]?.status).toBe("connected");
  });

  it("does not claim a provider connection when no provider adapter is configured", async () => {
    const { app, hub } = createApp();
    const now = "2026-11-08T12:00:00.000Z";
    await hub.register({
      id: "pos-main", tenantId: "merchant-1", family: "pos",
      providerKey: "generic-pos", displayName: "Main POS", status: "pending",
      capabilities: ["inventory.read"], createdAtUtc: now, updatedAtUtc: now
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/integrations/pos-main/verify"
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "provider_not_configured" });
    expect((await hub.list("merchant-1"))[0]?.status).toBe("pending");
  });

  it("allows merchant admins to suspend their own integration and blocks cross-tenant access", async () => {
    const { app, hub } = createApp();
    const now = "2026-11-08T12:00:00.000Z";
    await hub.register({
      id: "pos-main", tenantId: "merchant-1", family: "pos",
      providerKey: "generic-pos", displayName: "Main POS", status: "connected",
      capabilities: ["inventory.read"], createdAtUtc: now, updatedAtUtc: now
    });
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-2/integrations/pos-main/suspend"
    });
    expect(denied.statusCode).toBe(403);
    expect((await hub.list("merchant-1"))[0]?.status).toBe("connected");

    const suspended = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/integrations/pos-main/suspend"
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json()).toMatchObject({ outcome: "suspended", integrationId: "pos-main" });
    expect((await hub.list("merchant-1"))[0]?.status).toBe("suspended");
  });

  it("rejects malformed families and provider metadata", async () => {
    const { app, hub } = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/merchants/merchant-1/integrations",
      payload: {
        id: "x", family: "unknown", providerKey: "", displayName: "X",
        capabilities: ["inventory.read"]
      }
    });
    expect(response.statusCode).toBe(400);
    expect(await hub.list("merchant-1")).toEqual([]);
  });

  it("lists only the authenticated merchant's integrations and supports family filtering", async () => {
    const { app, hub } = createApp();
    const now = "2026-11-08T12:00:00.000Z";
    await hub.register({
      id: "pos-main", tenantId: "merchant-1", family: "pos",
      providerKey: "generic-pos", displayName: "Main POS", status: "pending",
      capabilities: ["inventory.read"], createdAtUtc: now, updatedAtUtc: now
    });
    await hub.register({
      id: "erp-main", tenantId: "merchant-1", family: "erp",
      providerKey: "generic-erp", displayName: "Main ERP", status: "pending",
      capabilities: ["catalog.read"], createdAtUtc: now, updatedAtUtc: now
    });
    await hub.register({
      id: "pos-other", tenantId: "merchant-2", family: "pos",
      providerKey: "generic-pos", displayName: "Other POS", status: "pending",
      capabilities: ["inventory.read"], createdAtUtc: now, updatedAtUtc: now
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/merchants/merchant-1/integrations?family=pos"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().integrations).toHaveLength(1);
    expect(response.json().integrations[0].id).toBe("pos-main");
  });
});
