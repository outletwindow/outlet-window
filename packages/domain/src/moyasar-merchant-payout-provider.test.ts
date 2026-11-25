import { describe, expect, it, vi } from "vitest";
import {
  MoyasarMerchantPayoutProvider,
  moyasarGivenIdFromOutboxKey
} from "./moyasar-merchant-payout-provider.js";

const options = {
  secretKey: "sk_test_example123",
  sourceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  sourceAccountType: "bank" as const,
  expectedLiveMode: false
};
const command = {
  payoutId: "payout-intent-1",
  outboxId: "outbox-merchant-1",
  amountMinor: 12500,
  currency: "SAR",
  idempotencyKey: "stable-outbox-idempotency-key",
  destination: {
    type: "bank" as const,
    iban: "SA8430400108057386290038",
    name: "Outlet Merchant",
    mobile: "+966500000000",
    country: "SA",
    city: "Jubail"
  }
};

function response(payload: unknown, status = 201): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe("MoyasarMerchantPayoutProvider", () => {
  it("derives a stable UUID v4 given_id from the durable idempotency key", () => {
    const first = moyasarGivenIdFromOutboxKey(command.outboxId, command.idempotencyKey);
    expect(first).toBe(moyasarGivenIdFromOutboxKey(command.outboxId, command.idempotencyKey));
    expect(first).not.toBe(moyasarGivenIdFromOutboxKey("another-outbox", command.idempotencyKey));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("submits the exact outbox metadata and treats provider acceptance only as submitted", async () => {
    const givenId = moyasarGivenIdFromOutboxKey(command.outboxId, command.idempotencyKey);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        source_id: options.sourceId,
        given_id: givenId,
        amount: 12500,
        purpose: "payment_to_merchant",
        metadata: {
          outlet_window_outbox_id: command.outboxId,
          outlet_window_payout_intent_id: command.payoutId
        },
        destination: {
          type: "bank",
          iban: "SA8430400108057386290038",
          country: "SA",
          city: "Jubail"
        }
      });
      return response({
        id: givenId, source_id: options.sourceId, status: "initiated",
        amount: 12500, currency: "SAR",
        metadata: { outlet_window_outbox_id: command.outboxId }
      });
    });
    const provider = new MoyasarMerchantPayoutProvider({ ...options, fetchImpl });
    await expect(provider.submit(command)).resolves.toEqual({
      status: "accepted", providerReference: givenId
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry ambiguous network or server outcomes", async () => {
    const network = new MoyasarMerchantPayoutProvider({
      ...options,
      fetchImpl: vi.fn(async () => { throw new Error("connection reset"); })
    });
    await expect(network.submit(command)).resolves.toEqual({
      status: "unknown", code: "MOYASAR_PAYOUT_OUTCOME_UNKNOWN"
    });

    const server = new MoyasarMerchantPayoutProvider({
      ...options, fetchImpl: vi.fn(async () => response({}, 503))
    });
    await expect(server.submit(command)).resolves.toEqual({
      status: "unknown", code: "MOYASAR_PAYOUT_OUTCOME_UNKNOWN"
    });
  });

  it("rejects destination/source account type mismatch before provider request", async () => {
    const fetchImpl = vi.fn(async () => response({}));
    const provider = new MoyasarMerchantPayoutProvider({ ...options, fetchImpl });
    await expect(provider.submit({
      ...command,
      destination: { type: "wallet", mobile: "+966500000000" }
    })).resolves.toEqual({ status: "rejected", code: "MOYASAR_PAYOUT_DESTINATION_INVALID" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("quarantines mismatched provider responses and maps returned payouts to reconciliation", async () => {
    const givenId = moyasarGivenIdFromOutboxKey(command.outboxId, command.idempotencyKey);
    const mismatch = new MoyasarMerchantPayoutProvider({
      ...options,
      fetchImpl: vi.fn(async () => response({
        id: givenId, source_id: options.sourceId, status: "initiated",
        amount: 1, currency: "SAR",
        metadata: { outlet_window_outbox_id: command.outboxId }
      }))
    });
    await expect(mismatch.submit(command)).resolves.toEqual({
      status: "unknown", code: "MOYASAR_PAYOUT_RESPONSE_MISMATCH"
    });

    const returned = new MoyasarMerchantPayoutProvider({
      ...options,
      fetchImpl: vi.fn(async () => response({
        id: givenId, source_id: options.sourceId, status: "returned",
        amount: 12500, currency: "SAR",
        metadata: { outlet_window_outbox_id: command.outboxId }
      }))
    });
    await expect(returned.submit(command)).resolves.toEqual({
      status: "unknown", code: "MOYASAR_PAYOUT_RETURNED_RECONCILIATION_REQUIRED"
    });
  });

  it("rejects live/test secret mode mismatch at construction", () => {
    expect(() => new MoyasarMerchantPayoutProvider({
      ...options, secretKey: "sk_live_example123"
    })).toThrow("INVALID_MOYASAR_PAYOUT_CONFIGURATION");
  });

  it("fetches payout status for reconciliation without issuing another transfer", async () => {
    const givenId = moyasarGivenIdFromOutboxKey(command.outboxId, command.idempotencyKey);
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(`https://api.moyasar.com/v1/payout/${givenId}`);
      expect(init?.method).toBe("GET");
      return response({
        id: givenId, source_id: options.sourceId, status: "paid",
        amount: 12500, currency: "SAR",
        updated_at: "2026-11-25T10:00:00.000Z",
        metadata: { outlet_window_outbox_id: command.outboxId }
      });
    });
    const provider = new MoyasarMerchantPayoutProvider({ ...options, fetchImpl });
    await expect(provider.fetchPayout({
      outboxId: command.outboxId, providerReference: givenId,
      amountMinor: command.amountMinor, currency: command.currency
    })).resolves.toEqual({
      outcome: "found", status: "paid", updatedAt: "2026-11-25T10:00:00.000Z"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not treat a mismatched lookup response as payout evidence", async () => {
    const givenId = moyasarGivenIdFromOutboxKey(command.outboxId, command.idempotencyKey);
    const provider = new MoyasarMerchantPayoutProvider({
      ...options,
      fetchImpl: vi.fn(async () => response({
        id: givenId, source_id: options.sourceId, status: "paid",
        amount: 1, currency: "SAR", updated_at: "2026-11-25T10:00:00.000Z",
        metadata: { outlet_window_outbox_id: command.outboxId }
      }))
    });
    await expect(provider.fetchPayout({
      outboxId: command.outboxId, providerReference: givenId,
      amountMinor: command.amountMinor, currency: command.currency
    })).resolves.toEqual({
      outcome: "unknown", code: "MOYASAR_PAYOUT_LOOKUP_MISMATCH"
    });
  });

});
