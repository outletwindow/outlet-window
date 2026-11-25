import { describe, expect, it, vi } from "vitest";
import {
  MerchantPayoutConfirmationWebhookProcessor,
  type MerchantPayoutConfirmationEventDecoder,
  type MerchantPayoutWebhookVerifier,
  type VerifiedMerchantPayoutConfirmationStore
} from "./merchant-payout-confirmation-webhook.js";

function fixture(overrides: {
  secret?: string | null;
  verified?: boolean;
  event?: ReturnType<MerchantPayoutConfirmationEventDecoder["decode"]>;
} = {}) {
  const calls: string[] = [];
  const verifier: MerchantPayoutWebhookVerifier = {
    verify: vi.fn(async ({ rawBody, secret }) => {
      calls.push("verify");
      return rawBody === '{"signed":true}' && secret === "vault-secret" && (overrides.verified ?? true);
    })
  };
  const decoder: MerchantPayoutConfirmationEventDecoder = {
    decode: vi.fn(() => {
      calls.push("decode");
      return overrides.event === undefined ? {
        providerEventId: "evt-payout-1",
        outboxId: "outbox-1",
        providerReference: "provider-ref-1",
        amountMinor: 12500,
        currency: "SAR"
      } : overrides.event;
    })
  };
  const store: VerifiedMerchantPayoutConfirmationStore = {
    confirmVerified: vi.fn(async input => {
      calls.push("persist");
      expect(input).toMatchObject({
        auditActorId: "payout-webhook-service",
        providerKey: "example-provider",
        providerEventId: "evt-payout-1",
        outboxId: "outbox-1",
        providerReference: "provider-ref-1",
        amountMinor: 12500,
        currency: "SAR"
      });
      expect(input.eventRowId).toMatch(/^[0-9a-f-]{36}$/);
      return { outcome: "confirmed" as const, journalId: "journal-1" };
    })
  };
  const processor = new MerchantPayoutConfirmationWebhookProcessor({
    secretResolver: vi.fn(async () => overrides.secret === undefined ? "vault-secret" : overrides.secret),
    verifier, decoder, store, auditActorId: "payout-webhook-service"
  });
  return { processor, verifier, decoder, store, calls };
}

describe("merchant payout confirmation webhook security boundary", () => {
  it("verifies the untouched body before decoding or persisting", async () => {
    const f = fixture();
    const result = await f.processor.process({ providerKey: "example-provider", rawBody: '{"signed":true}' });
    expect(result).toEqual({ outcome: "confirmed", journalId: "journal-1" });
    expect(f.calls).toEqual(["verify", "decode", "persist"]);
  });

  it("does not decode or persist an invalid signature", async () => {
    const f = fixture({ verified: false });
    expect(await f.processor.process({ providerKey: "example-provider", rawBody: '{"signed":true}' }))
      .toEqual({ outcome: "invalid_signature_or_event" });
    expect(f.decoder.decode).not.toHaveBeenCalled();
    expect(f.store.confirmVerified).not.toHaveBeenCalled();
  });

  it("does not decode or persist when the provider secret is unavailable", async () => {
    const f = fixture({ secret: null });
    expect(await f.processor.process({ providerKey: "example-provider", rawBody: '{"signed":true}' }))
      .toEqual({ outcome: "provider_not_configured" });
    expect(f.verifier.verify).not.toHaveBeenCalled();
    expect(f.decoder.decode).not.toHaveBeenCalled();
    expect(f.store.confirmVerified).not.toHaveBeenCalled();
  });

  it("rejects malformed normalized events before persistence", async () => {
    const f = fixture({ event: {
      providerEventId: "evt-payout-1", outboxId: "outbox-1",
      providerReference: "provider-ref-1", amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "SAR"
    } });
    expect(await f.processor.process({ providerKey: "example-provider", rawBody: '{"signed":true}' }))
      .toEqual({ outcome: "invalid_signature_or_event" });
    expect(f.store.confirmVerified).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before secret lookup", async () => {
    const f = fixture();
    expect(await f.processor.process({ providerKey: "example-provider", rawBody: "x".repeat(65_537) }))
      .toEqual({ outcome: "invalid_signature_or_event" });
    expect(f.verifier.verify).not.toHaveBeenCalled();
    expect(f.decoder.decode).not.toHaveBeenCalled();
  });
});
