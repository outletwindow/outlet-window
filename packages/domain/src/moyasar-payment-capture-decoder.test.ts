import { describe, expect, it } from "vitest";
import { moyasarPaymentCaptureDecoder } from "./moyasar-payment-capture-decoder.js";

function event(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "evt_capture_1",
    type: "payment_captured",
    created_at: "2026-11-10T07:00:00.000Z",
    secret_token: "secret",
    account_name: "Outlet Window",
    live: false,
    data: {
      id: "pay_123",
      status: "captured",
      amount: 12500,
      captured: 5000,
      currency: "SAR",
      captured_at: "2026-11-10T06:59:00.000Z"
    },
    ...overrides
  });
}

describe("Moyasar payment capture decoder", () => {
  it("maps the captured amount and provider payment ID, including partial capture", () => {
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event())).toEqual({
      providerEventId: "evt_capture_1",
      providerPaymentReference: "pay_123",
      amountMinor: 5000,
      currency: "SAR",
      capturedAtUtc: "2026-11-10T06:59:00.000Z"
    });
  });

  it("rejects paid, authorized, refunded and unrelated webhook events", () => {
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event({ type: "payment_paid" }))).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event({ type: "payment_authorized" }))).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event({ type: "payment_refunded" }))).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event({ type: "card_auth_authenticated" }))).toBeNull();
  });

  it("rejects capture events unless the nested payment status and captured amount are valid", () => {
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event({
      data: { id: "pay_123", status: "authorized", captured: 5000, currency: "SAR", captured_at: "2026-11-10T06:59:00Z" }
    }))).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event({
      data: { id: "pay_123", status: "captured", captured: 0, currency: "SAR", captured_at: "2026-11-10T06:59:00Z" }
    }))).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event({
      data: { id: "pay_123", status: "captured", captured: 5000, currency: "sar", captured_at: "2026-11-10T06:59:00Z" }
    }))).toBeNull();
  });

  it("rejects malformed envelopes and invalid timestamps", () => {
    expect(moyasarPaymentCaptureDecoder.decodeCapture("{")).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event({ created_at: "invalid" }))).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event({
      data: { id: "pay_123", status: "captured", captured: 5000, currency: "SAR", captured_at: "invalid" }
    }))).toBeNull();
  });
});
