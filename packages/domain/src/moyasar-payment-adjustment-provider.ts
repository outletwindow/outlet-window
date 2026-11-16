import type { PaymentAdjustmentCommand, PaymentAdjustmentProvider } from "./payment-adjustment-provider.js";
import type { MoyasarPaymentRefundClient } from "./moyasar-payment-refund-client.js";

/**
 * Moyasar's payment refund endpoint returns a payment snapshot, not a unique
 * refund-operation identifier. This adapter therefore reports acceptance
 * without fabricating a PSP reference; durable correlation remains the
 * original-capture reservation plus the signed cumulative refund webhook.
 */
export class MoyasarPaymentAdjustmentProvider implements PaymentAdjustmentProvider {
  constructor(private readonly client: Pick<MoyasarPaymentRefundClient, "refund">) {}

  async submit(command: PaymentAdjustmentCommand) {
    if (command.direction !== "refund") {
      return { status: "rejected" as const, code: "MOYASAR_ADDITIONAL_CHARGE_NOT_SUPPORTED_BY_REFUND_ADAPTER" };
    }
    if (!command.originalPaymentReference ||
        !Number.isSafeInteger(command.expectedRefundedMinor) ||
        (command.expectedRefundedMinor as number) < 0) {
      return { status: "rejected" as const, code: "MOYASAR_REFUND_CAPTURE_BINDING_REQUIRED" };
    }
    const result = await this.client.refund({
      paymentId: command.originalPaymentReference,
      amountMinor: command.amountMinor,
      currency: command.currency,
      expectedRefundedMinor: command.expectedRefundedMinor as number
    });
    if (result.outcome === "confirmed") return { status: "accepted" as const };
    if (result.outcome === "unknown") return { status: "unknown" as const, code: result.code };
    return { status: "rejected" as const, code: result.code };
  }
}
