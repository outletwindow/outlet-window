import { describe, expect, it } from "vitest";
import {
  createMoyasarMerchantPayoutWebhookVerifier,
  moyasarMerchantPayoutConfirmationEventDecoder,
  MoyasarMerchantPayoutConfirmationWebhookProcessor
} from "./moyasar-merchant-payout-webhook.js";

const secret = "sandbox-shared-secret";
const payload = {
  id: "evt-payout-1",
  type: "merchant_payout_paid",
  created_at: "2026-11-25T10:00:00.000Z",
  secret_token: secret,
  account_name: "Outlet Window Platform",
  live: false,
  merchant_id: "merchant-123",
  entity_id: "entity-456",
  data: {
    id: "payout-789",
    status: "paid",
    amount: 12500,
    currency: "SAR",
    metadata: { outlet_window_outbox_id: "outbox-123" }
  }
};
const rawBody = JSON.stringify(payload);
const headers = {
  "X-Event-ID": payload.id,
  "X-Event-Type": payload.type,
  "X-Event-Secret": secret,
  "X-Event-Attempt-Number": "1"
};

describe("Moyasar merchant payout webhook adapter", () => {
  it("verifies body and headers using Moyasar shared-secret semantics", () => {
    expect(createMoyasarMerchantPayoutWebhookVerifier(false).verify({ rawBody, headers, secret })).toBe(true);
  });

  it("rejects test/live mode mismatch", () => {
    expect(createMoyasarMerchantPayoutWebhookVerifier(true).verify({ rawBody, headers, secret })).toBe(false);
  });

  it("rejects mismatched header event identity", () => {
    expect(createMoyasarMerchantPayoutWebhookVerifier(false).verify({
      rawBody, headers: { ...headers, "X-Event-ID": "other-event" }, secret
    })).toBe(false);
  });

  it("rejects a missing or mismatched header secret", () => {
    expect(createMoyasarMerchantPayoutWebhookVerifier(false).verify({
      rawBody, headers: { ...headers, "X-Event-Secret": "wrong" }, secret
    })).toBe(false);
    const { "X-Event-Secret": _removed, ...missing } = headers;
    expect(createMoyasarMerchantPayoutWebhookVerifier(false).verify({
      rawBody, headers: missing, secret
    })).toBe(false);
  });

  it("rejects duplicate case-insensitive security headers", () => {
    expect(createMoyasarMerchantPayoutWebhookVerifier(false).verify({
      rawBody, headers: { ...headers, "x-event-secret": secret }, secret
    })).toBe(false);
  });

  it("decodes only paid merchant payout events and preserves merchant identity", () => {
    expect(moyasarMerchantPayoutConfirmationEventDecoder.decode(rawBody)).toEqual({
      providerEventId: "evt-payout-1",
      outboxId: "outbox-123",
      providerReference: "payout-789",
      amountMinor: 12500,
      currency: "SAR",
      merchantId: "merchant-123",
      entityId: "entity-456"
    });
  });

  it("rejects initiated, failed, returned, or malformed payouts from the paid journal path", () => {
    for (const status of ["initiated", "failed", "returned", "canceled"]) {
      expect(moyasarMerchantPayoutConfirmationEventDecoder.decode(
        JSON.stringify({ ...payload, data: { ...payload.data, status } })
      )).toBeNull();
    }
    expect(moyasarMerchantPayoutConfirmationEventDecoder.decode(
      JSON.stringify({ ...payload, data: { ...payload.data, amount: 0 } })
    )).toBeNull();
    expect(moyasarMerchantPayoutConfirmationEventDecoder.decode(
      JSON.stringify({ ...payload, data: { ...payload.data, metadata: {} } })
    )).toBeNull();
  });

  it("composes verification, paid-event decoding, and persistence with merchant identity", async () => {
    let persisted: Record<string, unknown> | undefined;
    const processor = new MoyasarMerchantPayoutConfirmationWebhookProcessor({
      secretResolver: async () => secret,
      expectedLiveMode: false,
      auditActorId: "payout-webhook-service",
      store: {
        confirmVerified: async input => {
          persisted = input;
          return { outcome: "confirmed" as const, journalId: "journal-1" };
        }
      }
    });
    await expect(processor.process({ rawBody, headers })).resolves.toEqual({
      outcome: "confirmed", journalId: "journal-1"
    });
    expect(persisted).toMatchObject({
      providerKey: "moyasar",
      providerEventId: payload.id,
      outboxId: "outbox-123",
      providerReference: "payout-789",
      amountMinor: 12500,
      currency: "SAR",
      merchantId: "merchant-123",
      entityId: "entity-456"
    });
  });
});
