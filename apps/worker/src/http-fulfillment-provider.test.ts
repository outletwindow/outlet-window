import { describe, expect, it, vi } from "vitest";
import { createHttpFulfillmentProvider } from "./http-fulfillment-provider.js";

const command = {
  taskType: "courier_dispatch" as const, orderId: "order-1",
  tenantId: "tenant-1", suborderId: "suborder-1",
  merchantId: "merchant-1", branchId: "branch-1",
  idempotencyKey: "dispatch:order-1:suborder-1:v1",
  executeAtUtc: "2026-11-08T12:00:00.000Z"
};

describe("HTTP fulfillment provider adapter", () => {
  it("sends tenant-scoped command with bearer auth and idempotency key", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer secret-token");
      expect(headers.get("idempotency-key")).toBe(command.idempotencyKey);
      expect(JSON.parse(String(init?.body))).toEqual(command);
      return new Response(JSON.stringify({ status: "accepted", providerReference: "ref-1" }), {
        status: 202, headers: { "content-type": "application/json" }
      });
    });
    const provider = createHttpFulfillmentProvider({
      endpoint: "https://provider.example/dispatch",
      bearerToken: "secret-token", providerName: "TEST", fetchImpl
    });
    await expect(provider.dispatch(command)).resolves.toEqual({
      status: "accepted", providerReference: "ref-1"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies transient HTTP responses for retry", async () => {
    const provider = createHttpFulfillmentProvider({
      endpoint: "https://provider.example/dispatch", bearerToken: "token",
      providerName: "TEST",
      fetchImpl: async () => new Response("busy", { status: 503 })
    });
    await expect(provider.dispatch(command)).resolves.toEqual({
      status: "retry", code: "PROVIDER_TEMPORARY_FAILURE"
    });
  });

  it("classifies client rejection as permanent", async () => {
    const provider = createHttpFulfillmentProvider({
      endpoint: "https://provider.example/dispatch", bearerToken: "token",
      providerName: "TEST",
      fetchImpl: async () => new Response("forbidden", { status: 403 })
    });
    await expect(provider.dispatch(command)).resolves.toEqual({
      status: "rejected", code: "PROVIDER_HTTP_403"
    });
  });

  it("rejects insecure endpoints and missing credentials before dispatch", () => {
    expect(() => createHttpFulfillmentProvider({
      endpoint: "http://provider.example/dispatch", bearerToken: "token", providerName: "TEST"
    })).toThrow("TEST_must_be_https_without_credentials_or_fragment");
    expect(() => createHttpFulfillmentProvider({
      endpoint: "https://provider.example/dispatch", bearerToken: "", providerName: "TEST"
    })).toThrow("TEST_token_required");
  });
});
