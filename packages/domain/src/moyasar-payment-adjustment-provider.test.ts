import { describe, expect, it, vi } from "vitest";
import { MoyasarPaymentAdjustmentProvider } from "./moyasar-payment-adjustment-provider.js";
import type { PaymentAdjustmentCommand } from "./payment-adjustment-provider.js";

const command: PaymentAdjustmentCommand = {
  adjustmentId: "adjustment-1", orderId: "order-1", idempotencyKey: "refund-idempotency-1",
  direction: "refund", amountMinor: 2500, currency: "SAR", customerId: "customer-1",
  originalPaymentReference: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  expectedRefundedMinor: 1000
};

describe("Moyasar payment adjustment provider", () => {
  it("submits a one-shot refund using the durable confirmed cumulative amount", async () => {
    const refund = vi.fn(async () => ({
      outcome: "confirmed" as const,
      payment: {
        id: command.originalPaymentReference!, status: "refunded" as const,
        amountMinor: 10000, capturedMinor: 10000, refundedMinor: 3500, currency: "SAR"
      },
      refundedThisAttemptMinor: 2500
    }));
    const provider = new MoyasarPaymentAdjustmentProvider({ refund });
    await expect(provider.submit(command)).resolves.toEqual({ status: "accepted" });
    expect(refund).toHaveBeenCalledWith({
      paymentId: command.originalPaymentReference, amountMinor: 2500,
      currency: "SAR", expectedRefundedMinor: 1000
    });
  });

  it("maps unknown and rejected provider outcomes without retrying the refund", async () => {
    const unknown = new MoyasarPaymentAdjustmentProvider({
      refund: vi.fn(async () => ({ outcome: "unknown" as const, code: "MOYASAR_REFUND_OUTCOME_UNKNOWN" }))
    });
    await expect(unknown.submit(command)).resolves.toEqual({
      status: "unknown", code: "MOYASAR_REFUND_OUTCOME_UNKNOWN"
    });
    const rejected = new MoyasarPaymentAdjustmentProvider({
      refund: vi.fn(async () => ({ outcome: "rejected" as const, code: "MOYASAR_REFUND_PRECONDITION_CONFLICT" }))
    });
    await expect(rejected.submit(command)).resolves.toEqual({
      status: "rejected", code: "MOYASAR_REFUND_PRECONDITION_CONFLICT"
    });
  });

  it("rejects charges and refund commands without a verified capture or cumulative baseline", async () => {
    const refund = vi.fn();
    const provider = new MoyasarPaymentAdjustmentProvider({ refund });
    await expect(provider.submit({ ...command, direction: "additional_charge" })).resolves.toMatchObject({
      status: "rejected", code: "MOYASAR_ADDITIONAL_CHARGE_NOT_SUPPORTED_BY_REFUND_ADAPTER"
    });
    const { originalPaymentReference: _originalPaymentReference, ...withoutCapture } = command;
    const { expectedRefundedMinor: _expectedRefundedMinor, ...withoutBaseline } = command;
    await expect(provider.submit(withoutCapture)).resolves.toMatchObject({
      status: "rejected", code: "MOYASAR_REFUND_CAPTURE_BINDING_REQUIRED"
    });
    await expect(provider.submit(withoutBaseline)).resolves.toMatchObject({
      status: "rejected", code: "MOYASAR_REFUND_CAPTURE_BINDING_REQUIRED"
    });
    expect(refund).not.toHaveBeenCalled();
  });
});
