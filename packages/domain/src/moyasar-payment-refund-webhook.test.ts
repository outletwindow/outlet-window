import { describe, expect, it, vi } from "vitest";
import { MoyasarPaymentRefundWebhookProcessor } from "./moyasar-payment-refund-webhook.js";

const paymentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const rawBody = JSON.stringify({
  id: "evt_refund_1",
  type: "payment_refunded",
  created_at: "2026-11-16T18:00:00.000Z",
  live: false,
  account_name: "Outlet Window Test",
  secret_token: "test-webhook-secret",
  data: {
    id: paymentId, status: "refunded", amount: 10000, captured: 10000,
    refunded: 2500, refunded_at: "2026-11-16T17:59:00.000Z", currency: "SAR"
  }
});

function makeProcessor(options: { verified?: boolean; secret?: string | null; outcome?: string } = {}) {
  const verify = vi.fn(() => options.verified ?? true);
  const secretResolver = vi.fn(async () => options.secret === undefined ? "test-webhook-secret" : options.secret);
  const recordAndReconcileMoyasarRefund = vi.fn(async () =>
    (options.outcome ?? "applied") as "applied");
  const processor = new MoyasarPaymentRefundWebhookProcessor({
    secretResolver,
    verifier: { verify },
    inbox: { recordAndReconcileMoyasarRefund }
  });
  return { processor, verify, secretResolver, recordAndReconcileMoyasarRefund };
}

describe("Moyasar payment refund webhook processor", () => {
  it("verifies the raw signed event and delegates the cumulative snapshot to atomic reconciliation", async () => {
    const mock = makeProcessor();
    await expect(mock.processor.process({ providerKey: "moyasar", rawBody })).resolves.toEqual({ outcome: "applied" });
    expect(mock.verify).toHaveBeenCalledWith({ rawBody, secret: "test-webhook-secret" });
    expect(mock.recordAndReconcileMoyasarRefund).toHaveBeenCalledWith({
      providerEventId: "evt_refund_1",
      rawBody,
      providerPaymentReference: paymentId,
      refundedMinor: 2500,
      refundableBaseMinor: 10000,
      currency: "SAR",
      refundedAtUtc: "2026-11-16T17:59:00.000Z"
    });
  });

  it("rejects a provider other than Moyasar and invalid webhook signatures before persistence", async () => {
    const mock = makeProcessor({ verified: false });
    await expect(mock.processor.process({ providerKey: "other", rawBody }))
      .resolves.toEqual({ outcome: "invalid_signature_or_event" });
    await expect(mock.processor.process({ providerKey: "moyasar", rawBody }))
      .resolves.toEqual({ outcome: "invalid_signature_or_event" });
    expect(mock.recordAndReconcileMoyasarRefund).not.toHaveBeenCalled();
  });

  it("fails closed when the secret is not configured or the event body is malformed", async () => {
    const noSecret = makeProcessor({ secret: null });
    await expect(noSecret.processor.process({ providerKey: "moyasar", rawBody }))
      .resolves.toEqual({ outcome: "provider_not_configured" });
    const malformed = makeProcessor();
    await expect(malformed.processor.process({ providerKey: "moyasar", rawBody: "{" }))
      .resolves.toEqual({ outcome: "invalid_signature_or_event" });
    expect(malformed.recordAndReconcileMoyasarRefund).not.toHaveBeenCalled();
  });

  it("rejects oversized webhook bodies before secret lookup or persistence", async () => {
    const mock = makeProcessor();
    await expect(mock.processor.process({
      providerKey: "moyasar", rawBody: "x".repeat(65_537)
    })).resolves.toEqual({ outcome: "invalid_signature_or_event" });
    expect(mock.secretResolver).not.toHaveBeenCalled();
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.recordAndReconcileMoyasarRefund).not.toHaveBeenCalled();
  });

  it("preserves reconciliation quarantine and idempotent duplicate outcomes", async () => {
    const quarantine = makeProcessor({ outcome: "reconciliation_required" });
    await expect(quarantine.processor.process({ providerKey: "moyasar", rawBody }))
      .resolves.toEqual({ outcome: "reconciliation_required" });
    const duplicate = makeProcessor({ outcome: "duplicate" });
    await expect(duplicate.processor.process({ providerKey: "moyasar", rawBody }))
      .resolves.toEqual({ outcome: "duplicate" });
  });
});
