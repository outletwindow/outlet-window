import type { DeliveryRoutingProvider, GeoPoint, RouteEstimate } from "./delivery-routing.js";

export interface HttpDeliveryRoutingProviderOptions {
  endpoint?: string;
  bearerToken?: string;
  providerName?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Adapter contract for a routing gateway controlled by the deployment.
 * The gateway must return { distanceMeters, durationSeconds, providerReference }.
 * Provider selection, credentials and commercial terms stay outside the domain package.
 */
export function createHttpDeliveryRoutingProvider(
  options: HttpDeliveryRoutingProviderOptions
): DeliveryRoutingProvider {
  const name = options.providerName ?? "DELIVERY_ROUTING";
  if (!options.endpoint || !options.bearerToken) {
    throw new Error(name + "_CONFIGURATION_REQUIRED");
  }
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); } catch {
    throw new Error(name + "_INVALID_ENDPOINT");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.hash || endpoint.search) {
    throw new Error(name + "_HTTPS_ENDPOINT_REQUIRED");
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15000) {
    throw new Error(name + "_INVALID_TIMEOUT");
  }
  const fetcher = options.fetchImpl ?? fetch;

  return {
    async estimateRoute(input: { origin: GeoPoint; destination: GeoPoint }): Promise<RouteEstimate | null> {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          "authorization": "Bearer " + options.bearerToken,
          "content-type": "application/json",
          "accept": "application/json"
        },
        body: JSON.stringify({
          origin: input.origin,
          destination: input.destination,
          units: "metric"
        }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error"
      });
      if (response.status === 404 || response.status === 422) return null;
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 425 ||
          response.status === 429 || response.status >= 500;
        throw new Error(name + (retryable ? "_TEMPORARY_FAILURE" : "_REQUEST_REJECTED"));
      }
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null) return null;
      const data = payload as Record<string, unknown>;
      if (!Number.isSafeInteger(data.distanceMeters) || (data.distanceMeters as number) < 0 ||
          !Number.isSafeInteger(data.durationSeconds) || (data.durationSeconds as number) < 0 ||
          typeof data.providerReference !== "string" || !data.providerReference.trim() ||
          data.providerReference.length > 240 ||
          typeof data.estimatedAtUtc !== "string" || !Number.isFinite(Date.parse(data.estimatedAtUtc))) return null;
      return {
        distanceMeters: data.distanceMeters as number,
        durationSeconds: data.durationSeconds as number,
        providerReference: data.providerReference,
        estimatedAtUtc: data.estimatedAtUtc
      };
    }
  };
}
