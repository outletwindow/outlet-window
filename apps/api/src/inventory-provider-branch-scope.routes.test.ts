import { afterEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../../packages/domain/src/authorization.js";
import { buildApp } from "./app.js";

const platformAdmin: Actor = {
  id: "platform-admin-1", role: "platform_admin", active: true,
  grants: [{
    resource: "platform.inventory_provider_branch_scope",
    actions: ["manage_access"],
    scope: { platform: true }
  }]
};
const merchantOwner: Actor = {
  id: "merchant-owner-1", role: "merchant_owner", active: true,
  grants: [{
    resource: "platform.inventory_provider_branch_scope",
    actions: ["manage_access"],
    scope: { platform: true }
  }]
};
const input = {
  tenantId: "tenant-1", integrationId: "pos-1",
  merchantId: "merchant-1", branchId: "branch-1"
};

describe("platform inventory provider branch scope routes", () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

  function createApp(actor: Actor | null, grant: "granted" | "not_eligible" = "granted", revoke: "revoked" | "not_found" = "revoked") {
    const grantScope = vi.fn(async () => grant);
    const revokeScope = vi.fn(async () => revoke);
    const append = vi.fn(async () => "inserted" as const);
    const app = buildApp({
      resolveActor: async () => actor,
      inventoryProviderBranchScopes: { grant: grantScope, revoke: revokeScope },
      auditEvents: { append }
    });
    apps.push(app);
    return { app, grantScope, revokeScope, append };
  }

  it("allows a platform admin to grant an eligible exact branch scope and audits the operation", async () => {
    const { app, grantScope, append } = createApp(platformAdmin);
    const response = await app.inject({
      method: "POST", url: "/api/v1/platform/inventory-provider-branch-scopes/grant", payload: input
    });
    expect(response.statusCode).toBe(201);
    expect(grantScope).toHaveBeenCalledWith(input);
    expect(append).toHaveBeenCalledTimes(3); // authorization, request, outcome
    expect(response.json().scope).toEqual(input);
  });

  it("rejects merchant roles even if a malformed grant is present", async () => {
    const { app, grantScope } = createApp(merchantOwner);
    const response = await app.inject({
      method: "POST", url: "/api/v1/platform/inventory-provider-branch-scopes/grant", payload: input
    });
    expect(response.statusCode).toBe(403);
    expect(grantScope).not.toHaveBeenCalled();
  });

  it("requires the explicit platform-wide manage_access grant", async () => {
    const actor: Actor = { ...platformAdmin, grants: [] };
    const { app, grantScope } = createApp(actor);
    const response = await app.inject({
      method: "POST", url: "/api/v1/platform/inventory-provider-branch-scopes/grant", payload: input
    });
    expect(response.statusCode).toBe(403);
    expect(grantScope).not.toHaveBeenCalled();
  });

  it("rejects ineligible providers without activating a branch grant", async () => {
    const { app, grantScope } = createApp(platformAdmin, "not_eligible");
    const response = await app.inject({
      method: "POST", url: "/api/v1/platform/inventory-provider-branch-scopes/grant", payload: input
    });
    expect(response.statusCode).toBe(409);
    expect(grantScope).toHaveBeenCalledOnce();
  });

  it("revokes the exact branch scope and records the outcome", async () => {
    const { app, revokeScope, append } = createApp(platformAdmin);
    const response = await app.inject({
      method: "POST", url: "/api/v1/platform/inventory-provider-branch-scopes/revoke", payload: input
    });
    expect(response.statusCode).toBe(200);
    expect(revokeScope).toHaveBeenCalledWith(input);
    expect(append).toHaveBeenCalledTimes(3);
  });

  it("validates every scope identifier before calling the store", async () => {
    const { app, grantScope } = createApp(platformAdmin);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/platform/inventory-provider-branch-scopes/grant",
      payload: { ...input, branchId: "branch/../../other-tenant" }
    });
    expect(response.statusCode).toBe(400);
    expect(grantScope).not.toHaveBeenCalled();
  });

  it("fails closed when audit persistence is unavailable", async () => {
    const app = buildApp({
      resolveActor: async () => platformAdmin,
      inventoryProviderBranchScopes: { grant: async () => "granted", revoke: async () => "revoked" }
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST", url: "/api/v1/platform/inventory-provider-branch-scopes/grant", payload: input
    });
    expect(response.statusCode).toBe(503);
  });
});
