import type {
  FulfillmentDispatchCommand,
  FulfillmentDispatchProvider
} from "../../../packages/domain/src/fulfillment-dispatch-handlers.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function requiredHttpsUrl(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name}_required`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name}_invalid`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${name}_must_be_https_without_credentials_or_fragment`);
  }
  return url.toString();
}

export function createHttpFulfillmentProvider(input: {
  endpoint: string | undefined;
  bearerToken: string | undefined;
  providerName: string;
  fetchImpl?: FetchLike;
}): FulfillmentDispatchProvider {
  const endpoint = requiredHttpsUrl(input.endpoint, `${input.providerName}_endpoint`);
  if (!input.bearerToken?.trim()) throw new Error(`${input.providerName}_token_required`);
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    async dispatch(command: FulfillmentDispatchCommand) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.bearerToken}`,
            "idempotency-key": command.idempotencyKey
          },
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(10_000)
        });
      } catch {
        return { status: "retry" as const, code: "PROVIDER_NETWORK_ERROR" };
      }
      if (response.status === 408 || response.status === 425 ||
          response.status === 429 || response.status >= 500) {
        return { status: "retry" as const, code: "PROVIDER_TEMPORARY_FAILURE" };
      }
      if (!response.ok) {
        return { status: "rejected" as const, code: `PROVIDER_HTTP_${response.status}` };
      }
      let payload: unknown;
      try { payload = await response.json(); } catch {
        return { status: "retry" as const, code: "PROVIDER_INVALID_RESPONSE" };
      }
      if (!payload || typeof payload !== "object" ||
          (payload as { status?: unknown }).status !== "accepted" ||
          typeof (payload as { providerReference?: unknown }).providerReference !== "string" ||
          !(payload as { providerReference: string }).providerReference.trim()) {
        return { status: "retry" as const, code: "PROVIDER_INVALID_RESPONSE" };
      }
      return {
        status: "accepted" as const,
        providerReference: (payload as { providerReference: string }).providerReference
      };
    }
  };
}
