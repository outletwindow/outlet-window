import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { Actor } from "../../../packages/domain/src/authorization.js";

const merchantActor: Actor = {
  id: "principal-1",
  role: "merchant_owner",
  active: true,
  grants: [{
    resource: "merchant.branch",
    actions: ["read"],
    scope: { merchantId: "merchant-1", branchId: "branch-1" }
  }]
};

describe("Outlet Window API foundation", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({ serviceName: "test-api", version: "test" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("exposes a health endpoint", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBeTruthy();
    expect(response.json()).toMatchObject({ status: "ok", service: "test-api", version: "test" });
  });

  it("exposes a readiness endpoint", async () => {
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ready");
  });

  it("reports not ready when a required database dependency is unavailable", async () => {
    const unavailableApp = buildApp({ readinessCheck: async () => false });
    await unavailableApp.ready();
    try {
      const response = await unavailableApp.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not_ready", checks: { process: "ok", database: "unavailable" } });
    } finally {
      await unavailableApp.close();
    }
  });

  it("reports not ready when the database health check throws", async () => {
    const unavailableApp = buildApp({ readinessCheck: async () => { throw new Error("db down"); } });
    await unavailableApp.ready();
    try {
      const response = await unavailableApp.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json().status).toBe("not_ready");
    } finally {
      await unavailableApp.close();
    }
  });

  it("exposes the versioned API foundation", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: "Outlet Window API", version: "v1" });
  });

  it("denies protected routes when no verified actor is resolved", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/merchants/merchant-1/branches/branch-1/access-check"
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthenticated" });
  });

  it("allows a verified actor only for its assigned merchant branch", async () => {
    const protectedApp = buildApp({ resolveActor: async () => merchantActor });
    await protectedApp.ready();
    try {
      const allowed = await protectedApp.inject({
        method: "GET",
        url: "/api/v1/merchants/merchant-1/branches/branch-1/access-check"
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual({ access: "granted" });

      const denied = await protectedApp.inject({
        method: "GET",
        url: "/api/v1/merchants/merchant-1/branches/branch-2/access-check"
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: "forbidden", reason: "scope_mismatch" });

      const otherMerchant = await protectedApp.inject({
        method: "GET",
        url: "/api/v1/merchants/merchant-2/branches/branch-1/access-check"
      });
      expect(otherMerchant.statusCode).toBe(403);
    } finally {
      await protectedApp.close();
    }
  });

  it("denies inactive actors even when they have a matching grant", async () => {
    const protectedApp = buildApp({
      resolveActor: async () => ({ ...merchantActor, active: false })
    });
    await protectedApp.ready();
    try {
      const response = await protectedApp.inject({
        method: "GET",
        url: "/api/v1/merchants/merchant-1/branches/branch-1/access-check"
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "forbidden", reason: "inactive_actor" });
    } finally {
      await protectedApp.close();
    }
  });
  it("requires merchant-scoped create permission before branch creation", async () => {
    let writes = 0;
    const protectedApp = buildApp({
      resolveActor: async () => merchantActor,
      merchantBranchWriter: {
        createBranch: async () => { writes += 1; return "created"; },
        updateBranch: async () => "updated"
      }
    });
    await protectedApp.ready();
    try {
      const denied = await protectedApp.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-2/branches",
        payload: { branchId: "branch-2", displayName: "Jubail East", cityCode: "JUB" }
      });
      expect(denied.statusCode).toBe(403);
      expect(writes).toBe(0);

      const actorWithCreate: Actor = {
        ...merchantActor,
        grants: [{ resource: "merchant.branch", actions: ["create"], scope: { merchantId: "merchant-1" } }]
      };
      const createApp = buildApp({
        resolveActor: async () => actorWithCreate,
        merchantBranchWriter: {
          createBranch: async () => { writes += 1; return "created"; },
          updateBranch: async () => "updated"
        }
      });
      await createApp.ready();
      try {
        const allowed = await createApp.inject({
          method: "POST",
          url: "/api/v1/merchants/merchant-1/branches",
          payload: { branchId: "branch-2", displayName: "Jubail East", cityCode: "JUB" }
        });
        expect(allowed.statusCode).toBe(201);
        expect(writes).toBe(1);
      } finally {
        await createApp.close();
      }
    } finally {
      await protectedApp.close();
    }
  });

  it("validates branch creation payloads", async () => {
    const actorWithCreate: Actor = {
      ...merchantActor,
      grants: [{ resource: "merchant.branch", actions: ["create"], scope: { merchantId: "merchant-1" } }]
    };
    const protectedApp = buildApp({
      resolveActor: async () => actorWithCreate,
      merchantBranchWriter: { createBranch: async () => "created", updateBranch: async () => "updated" }
    });
    await protectedApp.ready();
    try {
      const response = await protectedApp.inject({
        method: "POST",
        url: "/api/v1/merchants/merchant-1/branches",
        payload: { branchId: "x", displayName: " ", cityCode: "jub" }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_request" });
    } finally {
      await protectedApp.close();
    }
  });

  it("requires branch-scoped update permission and validates update payloads", async () => {
    let updates = 0;
    const owner: Actor = {
      ...merchantActor,
      grants: [{ resource: "merchant.branch", actions: ["update"], scope: { merchantId: "merchant-1", branchId: "branch-1" } }]
    };
    const protectedApp = buildApp({
      resolveActor: async () => owner,
      merchantBranchWriter: {
        createBranch: async () => "created",
        updateBranch: async () => { updates += 1; return "updated"; }
      }
    });
    await protectedApp.ready();
    try {
      const denied = await protectedApp.inject({
        method: "PATCH",
        url: "/api/v1/merchants/merchant-1/branches/branch-2",
        payload: { displayName: "Changed", cityCode: "JUB", status: "active" }
      });
      expect(denied.statusCode).toBe(403);
      expect(updates).toBe(0);

      const allowed = await protectedApp.inject({
        method: "PATCH",
        url: "/api/v1/merchants/merchant-1/branches/branch-1",
        payload: { displayName: "Jubail Updated", cityCode: "JUB", status: "inactive" }
      });
      expect(allowed.statusCode).toBe(200);
      expect(updates).toBe(1);

      const invalid = await protectedApp.inject({
        method: "PATCH",
        url: "/api/v1/merchants/merchant-1/branches/branch-1",
        payload: { displayName: "x", cityCode: "JUB", status: "active" }
      });
      expect(invalid.statusCode).toBe(400);
      expect(updates).toBe(1);
    } finally {
      await protectedApp.close();
    }
  });

