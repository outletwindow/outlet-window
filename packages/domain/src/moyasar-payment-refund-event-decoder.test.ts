import { describe, expect, it } from "vitest";
import { moyasarPaymentRefundEventDecoder } from "./moyasar-payment-refund-event-decoder.js";

const paymentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
function event(overrides: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "evt_refund_1",
    type: "payment_refunded",
    created_at: "2026-11-16T18:00:00.000Z",
    live: false,
    data: {
      id: paymentId,
      status: "refunded",
      amount: 10_000,
      captured: 10_000,
      refunded: 2_500,
      refunded_at: "2026-11-16T17:59:00.000Z",
      currency: "SAR",
      ...overrides
    },
    ...envelope
  });
}

describe("Moyasar payment refund event decoder", () => {
  it("decodes a cumulative refund snapshot without inventing a refund id", () => {
    expect(moyasarPaymentRefundEventDecoder.decode(event())).toEqual({
      providerEventId: "evt_refund_1",
      providerPaymentReference: paymentId,
      refundedMinor: 2_500,
      refundableBaseMinor: 10_000,
      currency: "SAR",
      refundedAtUtc: "2026-11-16T17:59:00.000Z",
      live: false
    });
  });

  it("uses original amount when paid-payment snapshots have zero captured amount", () => {
    expect(moyasarPaymentRefundEventDecoder.decode(event({
      amount: 10_000, captured: 0, refunded: 10_000
    }))).toMatchObject({ refundableBaseMinor: 10_000, refundedMinor: 10_000 });
  });

  it("rejects unsupported events and malformed event envelopes", () => {
    expect(moyasarPaymentRefundEventDecoder.decode(event({}, { type: "payment_paid" }))).toBeNull();
    expect(moyasarPaymentRefundEventDecoder.decode("{")).toBeNull();
    expect(moyasarPaymentRefundEventDecoder.decode(event({}, { live: "false" }))).toBeNull();
    expect(moyasarPaymentRefundEventDecoder.decode(event({}, { created_at: "invalid" }))).toBeNull();
  });

  it("rejects inconsistent payment identity, status, amount, currency, and refund totals", () => {
    expect(moyasarPaymentRefundEventDecoder.decode(event({ id: "not-a-uuid" }))).toBeNull();
    expect(moyasarPaymentRefundEventDecoder.decode(event({ status: "captured" }))).toBeNull();
    expect(moyasarPaymentRefundEventDecoder.decode(event({ amount: 0 }))).toBeNull();
    expect(moyasarPaymentRefundEventDecoder.decode(event({ captured: 10_001 }))).toBeNull();
    expect(moyasarPaymentRefundEventDecoder.decode(event({ refunded: 10_001 }))).toBeNull();
    expect(moyasarPaymentRefundEventDecoder.decode(event({ currency: "sar" }))).toBeNull();
    expect(moyasarPaymentRefundEventDecoder.decode(event({ refunded: 0 }))).toBeNull();
  });

  it("uses event creation time when refunded_at is absent or malformed", () => {
    expect(moyasarPaymentRefundEventDecoder.decode(event({ refunded_at: null })))
      .toMatchObject({ refundedAtUtc: "2026-11-16T18:00:00.000Z" });
    expect(moyasarPaymentRefundEventDecoder.decode(event({ refunded_at: "invalid" })))
      .toMatchObject({ refundedAtUtc: "2026-11-16T18:00:00.000Z" });
  });
});
