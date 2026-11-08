import { describe, expect, it, vi } from "vitest";
import { createHttpDeliveryRoutingProvider } from "./http-delivery-routing-provider.js";

const options = {
  endpoint: "https://routing-gateway.example/v1/route",
  bearerToken: "test-secret",
  fetchImpl: vi.fn(async () => new Response(JSON.stringify({
    distanceMeters: 2400, durationSeconds: 480, providerReference: "route-123"
  }), { status: 200, headers: { "content-type": "application/json" } }))
};

describe("HTTP delivery routing gateway", () => {
  it("sends metric origin/destination to the HTTPS gateway and normalizes a fresh estimate", async () => {
    const provider = createHttpDeliveryRoutingProvider(options);
    const estimate = await provider.estimateRoute({
      origin: { latitude: 27, longitude: 49 },
      destination: { latitude: 27.01, longitude: 49.01 }
    });
    expect(estimate).toMatchObject({
      distanceMeters: 2400, durationSeconds: 480, providerReference: "route-123"
    });
    expect(Date.parse(estimate!.estimatedAtUtc)).toBeGreaterThan(0);
    expect(options.fetchImpl).toHaveBeenCalledWith(
      new URL(options.endpoint),
      expect.objectContaining({
        method: "POST", redirect: "error",
        headers: expect.objectContaining({ authorization: "Bearer test-secret" })
      })
    );
  });

  it("rejects missing credentials, non-HTTPS endpoints and unsafe timeout values", () => {
    expect(() => createHttpDeliveryRoutingProvider({ endpoint: options.endpoint }))
      .toThrow("DELIVERY_ROUTING_CONFIGURATION_REQUIRED");
    expect(() => createHttpDeliveryRoutingProvider({
      endpoint: "http://routing.example/route", bearerToken: "x"
    })).toThrow("DELIVERY_ROUTING_HTTPS_ENDPOINT_REQUIRED");
    expect(() => createHttpDeliveryRoutingProvider({
      endpoint: options.endpoint, bearerToken: "x", timeoutMs: 100000
    })).toThrow("DELIVERY_ROUTING_INVALID_TIMEOUT");
  });

  it("treats route-not-found as unavailable and rejects malformed successful responses", async () => {
    const notFound = createHttpDeliveryRoutingProvider({
      endpoint: options.endpoint, bearerToken: "x",
      fetchImpl: vi.fn(async () => new Response(null, { status: 404 }))
    });
    await expect(notFound.estimateRoute({
      origin: { latitude: 27, longitude: 49 }, destination: { latitude: 27.1, longitude: 49.1 }
    })).resolves.toBeNull();

    const malformed = createHttpDeliveryRoutingProvider({
      endpoint: options.endpoint, bearerToken: "x",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        distanceMeters: -1, durationSeconds: 10, providerReference: ""
      }), { status: 200 }))
    });
    await expect(malformed.estimateRoute({
      origin: { latitude: 27, longitude: 49 }, destination: { latitude: 27.1, longitude: 49.1 }
    })).resolves.toBeNull();
  });

  it("classifies retryable provider errors without exposing response bodies", async () => {
    const failing = createHttpDeliveryRoutingProvider({
      endpoint: options.endpoint, bearerToken: "x",
      fetchImpl: vi.fn(async () => new Response("sensitive provider detail", { status: 503 }))
    });
    await expect(failing.estimateRoute({
      origin: { latitude: 27, longitude: 49 }, destination: { latitude: 27.1, longitude: 49.1 }
    })).rejects.toThrow("DELIVERY_ROUTING_TEMPORARY_FAILURE");
  });
});
