export type ClaimedPaymentWebhook = {
  receiptId: string;
  providerKey: string;
  providerEventId: string;
  adjustmentId: string | null;
  eventType: string | null;
  normalizedStatus: "succeeded" | "failed" | "ignored" | "unsupported" | null;
  providerReference: string | null;
  failureCode: string | null;
  attemptCount: number;
};

export interface PaymentWebhookWorkerStore {
  claimNext(workerId: string, leaseSeconds?: number): Promise<ClaimedPaymentWebhook | null>;
  reconcileAdjustment(input: {
    receiptId: string;
    adjustmentId: string;
    actorId: string;
    workerId: string;
    confirmed: boolean;
    providerReference?: string;
    failureCode?: string;
  }): Promise<"applied" | "failed" | "not_processing" | "conflict">;
  finalize(input: {
    receiptId: string;
    status: "applied" | "ignored" | "failed";
    adjustmentId?: string;
    failureCode?: string;
    workerId?: string;
  }): Promise<"finalized" | "not_processing">;
  releaseForRetry(input: {
    receiptId: string;
    workerId: string;
    delaySeconds: number;
    failureCode: string;
  }): Promise<"rescheduled" | "dead_lettered" | "lease_lost">;
}

export type PaymentWebhookWorkerResult =
  | { outcome: "idle" }
  | { outcome: "applied" | "failed" | "ignored" | "retry_scheduled" | "dead_lettered" | "lease_lost"; receiptId: string };

/** Processes one normalized, signature-verified webhook envelope at a time. */
export class PaymentWebhookWorker {
  constructor(
    private readonly store: PaymentWebhookWorkerStore,
    private readonly workerId: string,
    private readonly leaseSeconds = 30
  ) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(workerId) ||
        !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) {
      throw new Error("INVALID_PAYMENT_WEBHOOK_WORKER_CONFIGURATION");
    }
  }

  async runOnce(): Promise<PaymentWebhookWorkerResult> {
    const event = await this.store.claimNext(this.workerId, this.leaseSeconds);
    if (!event) return { outcome: "idle" };
    try {
      if (event.normalizedStatus === "ignored") {
        const result = await this.store.finalize({
          receiptId: event.receiptId, status: "ignored", workerId: this.workerId
        });
        return { outcome: result === "finalized" ? "ignored" : "lease_lost", receiptId: event.receiptId };
      }
      if (event.normalizedStatus === "unsupported" || event.normalizedStatus === null) {
        const result = await this.store.finalize({
          receiptId: event.receiptId, status: "failed",
          failureCode: "UNSUPPORTED_PROVIDER_EVENT", workerId: this.workerId
        });
        return { outcome: result === "finalized" ? "failed" : "lease_lost", receiptId: event.receiptId };
      }
      if (!event.adjustmentId) {
        const result = await this.store.finalize({
          receiptId: event.receiptId, status: "failed",
          failureCode: "PAYMENT_ADJUSTMENT_REFERENCE_MISSING", workerId: this.workerId
        });
        return { outcome: result === "finalized" ? "failed" : "lease_lost", receiptId: event.receiptId };
      }
      const confirmed = event.normalizedStatus === "succeeded";
      if (confirmed && !event.providerReference) {
        const result = await this.store.finalize({
          receiptId: event.receiptId, status: "failed",
          adjustmentId: event.adjustmentId,
          failureCode: "PROVIDER_REFERENCE_MISSING", workerId: this.workerId
        });
        return { outcome: result === "finalized" ? "failed" : "lease_lost", receiptId: event.receiptId };
      }
      const result = await this.store.reconcileAdjustment({
        receiptId: event.receiptId,
        adjustmentId: event.adjustmentId,
        actorId: this.workerId,
        workerId: this.workerId,
        confirmed,
        ...(event.providerReference ? { providerReference: event.providerReference } : {}),
        ...(event.failureCode ? { failureCode: event.failureCode } : {})
      });
      if (result === "applied" || result === "failed") {
        return { outcome: result, receiptId: event.receiptId };
      }
      if (result === "not_processing") {
        return { outcome: "lease_lost", receiptId: event.receiptId };
      }
      return this.retry(event);
    } catch {
      return this.retry(event);
    }
  }

  private async retry(event: ClaimedPaymentWebhook): Promise<PaymentWebhookWorkerResult> {
    const delaySeconds = Math.min(3_600, 5 * 2 ** Math.min(Math.max(event.attemptCount - 1, 0), 9));
    const result = await this.store.releaseForRetry({
      receiptId: event.receiptId, workerId: this.workerId,
      delaySeconds, failureCode: "WEBHOOK_RECONCILIATION_RETRY"
    });
    const outcome = result === "rescheduled" ? "retry_scheduled" :
      result === "dead_lettered" ? "dead_lettered" : "lease_lost";
    return { outcome, receiptId: event.receiptId };
  }
}
