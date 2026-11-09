import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { VerifiedOrderPaymentCaptureWebhookProcessor } from "./verified-order-payment-capture-webhook.js";

const secret = "payment-capture-test-secret-with-more-than-32-bytes";
const now = new Date("2026-11-09T12:00:00.000Z");
const rawBody = JSON.stringify({
  id: "evt-capture-1", paymentReference: "intent-1",
  amountMinor: 12500, currency: "SAR", capturedAtUtc: "2026-11-09T11:59:00.000Z"
});
function signature(body: string): string {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(timestamp + "." + body).digest("hex")}`;
}
function createProcessor(overrides: Record<string, unknown> = {}) {
  const recordVerifiedCapture = vi.fn(async () => ({ outcome: "inserted" as const, captureId: "capture-1" }));
  const orderResolver = {
    findExpectedOrder: vi.fn(async () => ({ tenantId: "tenant-1", orderId: "order-1" }))
  };
  const processor = new VerifiedOrderPaymentCaptureWebhookProcessor({
    secretResolver: async () => secret,
    decoders: new Map([["psp-a", {
      decodeCapture: (raw: string) => {
        const value = JSON.parse(raw) as Record<string, unknown>;
        return {
          providerEventId: value.id as string,
          providerPaymentReference: value.paymentReference as string,
          amountMinor: value.amountMinor as number,
          currency: value.currency as string,
          capturedAtUtc: value.capturedAtUtc as string
        };
      }
    }]]),
    orderResolver,
    captureStore: { recordVerifiedCapture },
    now: () => now,
    ...overrides
  } as ConstructorParameters<typeof VerifiedOrderPaymentCaptureWebhookProcessor>[0]);
  return { processor, recordVerifiedCapture, orderResolver };
}

describe("verified initial order payment capture webhook processor", () => {
  it("verifies the signed raw event and resolves the order from the server-owned payment intent", async () => {
    const { processor, recordVerifiedCapture, orderResolver } = createProcessor();
    await expect(processor.process({
      providerKey: "psp-a", rawBody, signatureHeader: signature(rawBody)
    })).resolves.toEqual({ outcome: "recorded", captureId: "capture-1" });
    expect(orderResolver.findExpectedOrder).toHaveBeenCalledWith({
      providerKey: "psp-a", providerPaymentReference: "intent-1", amountMinor: 12500, currency: "SAR"
    });
    expect(recordVerifiedCapture).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1", orderId: "order-1", providerKey: "psp-a",
      providerEventId: "evt-capture-1", amountMinor: 12500, currency: "SAR",
      idempotencyKey: "payment-capture:psp-a:evt-capture-1"
    }));
  });

  it("rejects an invalid signature before resolving or writing", async () => {
    const { processor, recordVerifiedCapture, orderResolver } = createProcessor();
    await expect(processor.process({
      providerKey: "psp-a", rawBody, signatureHeader: signature(rawBody).replace(/v1=.*/, "v1=" + "0".repeat(64))
    })).resolves.toEqual({ outcome: "invalid_signature_or_event" });
    expect(orderResolver.findExpectedOrder).not.toHaveBeenCalled();
    expect(recordVerifiedCapture).not.toHaveBeenCalled();
  });

  it("does not trust order identifiers supplied in webhook payload metadata", async () => {
    const { processor, recordVerifiedCapture, orderResolver } = createProcessor();
    const body = JSON.stringify({ ...JSON.parse(rawBody), tenantId: "attacker", orderId: "other-order" });
    await processor.process({ providerKey: "psp-a", rawBody: body, signatureHeader: signature(body) });
    expect(orderResolver.findExpectedOrder).toHaveBeenCalledWith({
      providerKey: "psp-a", providerPaymentReference: "intent-1", amountMinor: 12500, currency: "SAR"
    });
    expect(recordVerifiedCapture).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1", orderId: "order-1"
    }));
  });

  it("fails closed when the provider payment intent cannot be mapped to an order", async () => {
    const { processor, recordVerifiedCapture } = createProcessor({
      orderResolver: { findExpectedOrder: vi.fn(async () => null) }
    });
    await expect(processor.process({
      providerKey: "psp-a", rawBody, signatureHeader: signature(rawBody)
    })).resolves.toEqual({ outcome: "payment_intent_not_found" });
    expect(recordVerifiedCapture).not.toHaveBeenCalled();
  });

  it("rejects a capture timestamp materially in the future", async () => {
    const { processor, recordVerifiedCapture } = createProcessor();
    const body = JSON.stringify({ ...JSON.parse(rawBody), capturedAtUtc: "2026-11-09T12:10:00.000Z" });
    await expect(processor.process({
      providerKey: "psp-a", rawBody: body, signatureHeader: signature(body)
    })).resolves.toEqual({ outcome: "invalid_signature_or_event" });
    expect(recordVerifiedCapture).not.toHaveBeenCalled();
  });
});
