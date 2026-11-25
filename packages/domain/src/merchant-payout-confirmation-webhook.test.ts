import { describe, expect, it, vi } from "vitest";
import {
  MerchantPayoutConfirmationWebhookProcessor,
  type MerchantPayoutConfirmationEventDecoder,
  type MerchantPayoutWebhookVerifier,
  type VerifiedMerchantPayoutConfirmationStore
} from "./merchant-payout-confirmation-webhook.js";

const request = {
  providerKey: "example-provider",
  rawBody: '{"signed":true}',
  headers: { "x-provider-signature": "signature-value", "x-provider-timestamp": "1732530000" }
};

function fixture(overrides: {
  secret?: string | null;
  secretResolverError?: boolean;
  verified?: boolean;
  event?: ReturnType<MerchantPayoutConfirmationEventDecoder["decode"]>;
} = {}) {
  const calls: string[] = [];
  const verifier: MerchantPayoutWebhookVerifier = {
    verify: vi.fn(async ({ rawBody, secret, headers }) => {
      calls.push("verify");
      expect(headers).toEqual(request.headers);
      return rawBody === request.rawBody && secret === "vault-secret" &&
        headers["x-provider-signature"] === "signature-value" && (overrides.verified ?? true);
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
    secretResolver: vi.fn(async () => {
      if (overrides.secretResolverError) throw new Error("vault unavailable");
      return overrides.secret === undefined ? "vault-secret" : overrides.secret;
    }),
    verifier, decoder, store, auditActorId: "payout-webhook-service"
  });
  return { processor, verifier, decoder, store, calls };
}

describe("merchant payout confirmation webhook security boundary", () => {
  it("verifies the untouched body and signed headers before decoding or persisting", async () => {
    const f = fixture();
    const result = await f.processor.process(request);
    expect(result).toEqual({ outcome: "confirmed", journalId: "journal-1" });
    expect(f.calls).toEqual(["verify", "decode", "persist"]);
  });

  it("does not decode or persist an invalid signature", async () => {
    const f = fixture({ verified: false });
    expect(await f.processor.process(request)).toEqual({ outcome: "invalid_signature_or_event" });
    expect(f.decoder.decode).not.toHaveBeenCalled();
    expect(f.store.confirmVerified).not.toHaveBeenCalled();
  });

  it("does not decode or persist when the provider secret is unavailable", async () => {
    const f = fixture({ secret: null });
    expect(await f.processor.process(request)).toEqual({ outcome: "provider_not_configured" });
    expect(f.verifier.verify).not.toHaveBeenCalled();
    expect(f.decoder.decode).not.toHaveBeenCalled();
    expect(f.store.confirmVerified).not.toHaveBeenCalled();
  });

  it("fails closed when the secret resolver throws", async () => {
    const f = fixture({ secretResolverError: true });
    expect(await f.processor.process(request)).toEqual({ outcome: "provider_not_configured" });
    expect(f.verifier.verify).not.toHaveBeenCalled();
    expect(f.decoder.decode).not.toHaveBeenCalled();
    expect(f.store.confirmVerified).not.toHaveBeenCalled();
  });

  it("rejects malformed normalized events before persistence", async () => {
    const f = fixture({ event: {
      providerEventId: "evt-payout-1", outboxId: "outbox-1",
      providerReference: "provider-ref-1", amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "SAR"
    } });
    expect(await f.processor.process(request)).toEqual({ outcome: "invalid_signature_or_event" });
    expect(f.store.confirmVerified).not.toHaveBeenCalled();
  });

  it("rejects malformed headers before secret lookup", async () => {
    const f = fixture();
    expect(await f.processor.process({ ...request, headers: { "bad header": "x" } }))
      .toEqual({ outcome: "invalid_signature_or_event" });
    expect(f.verifier.verify).not.toHaveBeenCalled();
    expect(f.decoder.decode).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before secret lookup", async () => {
    const f = fixture();
    expect(await f.processor.process({ ...request, rawBody: "x".repeat(65_537) }))
      .toEqual({ outcome: "invalid_signature_or_event" });
    expect(f.verifier.verify).not.toHaveBeenCalled();
    expect(f.decoder.decode).not.toHaveBeenCalled();
  });
});
