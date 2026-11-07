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
});
