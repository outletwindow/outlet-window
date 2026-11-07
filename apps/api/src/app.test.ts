import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

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
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "test-api",
      version: "test"
    });
  });

  it("exposes a readiness endpoint", async () => {
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ready");
  });

  it("exposes the versioned API foundation", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: "Outlet Window API", version: "v1" });
  });
});
