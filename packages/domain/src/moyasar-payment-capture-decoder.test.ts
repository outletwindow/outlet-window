import { describe, expect, it } from "vitest";
import { moyasarPaymentCaptureDecoder } from "./moyasar-payment-capture-decoder.js";

function event(type = "payment_captured", dataOverrides: Record<string, unknown> = {}, envelopeOverrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "evt_capture_1",
    type,
    created_at: "2026-11-10T07:00:00.000Z",
    secret_token: "secret",
    account_name: "Outlet Window",
    live: false,
    data: {
      id: "pay_123",
      status: type === "payment_paid" ? "paid" : "captured",
      amount: 5000,
      captured: 5000,
      currency: "SAR",
      captured_at: "2026-11-10T06:59:00.000Z",
      updated_at: "2026-11-10T06:59:00.000Z",
      ...dataOverrides
    },
    ...envelopeOverrides
  });
}

describe("Moyasar payment capture decoder", () => {
  it("maps a successful purchase event to the full paid amount", () => {
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event("payment_paid", {
      status: "paid", captured: 0, captured_at: null
    }))).toEqual({
      providerEventId: "evt_capture_1",
      providerPaymentReference: "pay_123",
      amountMinor: 5000,
      currency: "SAR",
      capturedAtUtc: "2026-11-10T06:59:00.000Z"
    });
  });

  it("maps a successful manual capture event to captured funds", () => {
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event())).toEqual({
      providerEventId: "evt_capture_1",
      providerPaymentReference: "pay_123",
      amountMinor: 5000,
      currency: "SAR",
      capturedAtUtc: "2026-11-10T06:59:00.000Z"
    });
  });

  it("rejects partial captures until partial-order payment accounting is supported", () => {
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event("payment_captured", {
      amount: 12500, captured: 5000
    }))).toBeNull();
  });

  it("rejects authorized, failed, refunded, voided and unrelated webhook events", () => {
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event("payment_authorized", { status: "authorized" }))).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event("payment_faild", { status: "failed" }))).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event("payment_refunded", { status: "refunded" }))).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event("payment_voided", { status: "voided" }))).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event("card_auth_authenticated"))).toBeNull();
  });

  it("rejects mismatched payment status, zero amount, and malformed currency", () => {
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event("payment_paid", { status: "authorized" }))).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event("payment_paid", { amount: 0 }))).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event("payment_paid", { currency: "sar" }))).toBeNull();
  });

  it("rejects malformed envelopes and invalid timestamps", () => {
    expect(moyasarPaymentCaptureDecoder.decodeCapture("{")).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event("payment_paid", {}, { created_at: "invalid" }))).toBeNull();
    expect(moyasarPaymentCaptureDecoder.decodeCapture(event("payment_captured", {
      captured_at: "invalid"
    }))).toBeNull();
  });
});
