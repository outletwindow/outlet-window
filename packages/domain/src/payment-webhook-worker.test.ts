import { describe, expect, it, vi } from "vitest";
import { PaymentWebhookWorker, type ClaimedPaymentWebhook, type PaymentWebhookWorkerStore } from "./payment-webhook-worker.js";

const event: ClaimedPaymentWebhook = {
  receiptId: "receipt-1", providerKey: "psp-a", providerEventId: "evt-1",
  adjustmentId: "adjustment-1", eventType: "payment.adjustment",
  normalizedStatus: "succeeded", providerReference: "psp-ref-1",
  failureCode: null, attemptCount: 1
};

function makeStore(overrides: Partial<PaymentWebhookWorkerStore> = {}) {
  const store: PaymentWebhookWorkerStore = {
    claimNext: vi.fn(async () => event),
    reconcileAdjustment: vi.fn(async () => "applied" as const),
    finalize: vi.fn(async () => "finalized" as const),
    releaseForRetry: vi.fn(async () => "rescheduled" as const),
    ...overrides
  };
  return store;
}

describe("payment webhook worker", () => {
  it("reconciles provider-confirmed adjustment events through the atomic store operation", async () => {
    const store = makeStore();
    const worker = new PaymentWebhookWorker(store, "worker-1");
    await expect(worker.runOnce()).resolves.toEqual({ outcome: "applied", receiptId: "receipt-1" });
    expect(store.reconcileAdjustment).toHaveBeenCalledWith({
      receiptId: "receipt-1", adjustmentId: "adjustment-1",
      actorId: "worker-1", workerId: "worker-1",
      confirmed: true, providerReference: "psp-ref-1"
    });
  });

  it("records provider-declined adjustment events without changing the order total", async () => {
    const store = makeStore({
      claimNext: vi.fn(async () => ({ ...event, normalizedStatus: "failed", providerReference: null }))
    });
    const worker = new PaymentWebhookWorker(store, "worker-1");
    await expect(worker.runOnce()).resolves.toEqual({ outcome: "failed", receiptId: "receipt-1" });
    expect(store.reconcileAdjustment).toHaveBeenCalledWith(expect.objectContaining({
      confirmed: false
    }));
  });

  it("finalizes ignored and unsupported provider events without adjustment writes", async () => {
    const ignoredStore = makeStore({
      claimNext: vi.fn(async () => ({ ...event, adjustmentId: null, normalizedStatus: "ignored" }))
    });
    await expect(new PaymentWebhookWorker(ignoredStore, "worker-1").runOnce())
      .resolves.toEqual({ outcome: "ignored", receiptId: "receipt-1" });
    expect(ignoredStore.reconcileAdjustment).not.toHaveBeenCalled();

    const unsupportedStore = makeStore({
      claimNext: vi.fn(async () => ({ ...event, normalizedStatus: "unsupported" }))
    });
    await expect(new PaymentWebhookWorker(unsupportedStore, "worker-1").runOnce())
      .resolves.toEqual({ outcome: "failed", receiptId: "receipt-1" });
    expect(unsupportedStore.finalize).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed", failureCode: "UNSUPPORTED_PROVIDER_EVENT", workerId: "worker-1"
    }));
  });

  it("retries conflicts with exponential backoff and dead-letter outcome", async () => {
    const retryStore = makeStore({ reconcileAdjustment: vi.fn(async () => "conflict" as const) });
    await expect(new PaymentWebhookWorker(retryStore, "worker-1").runOnce())
      .resolves.toEqual({ outcome: "retry_scheduled", receiptId: "receipt-1" });
    expect(retryStore.releaseForRetry).toHaveBeenCalledWith(expect.objectContaining({
      delaySeconds: 5, failureCode: "WEBHOOK_RECONCILIATION_RETRY"
    }));

    const deadStore = makeStore({
      reconcileAdjustment: vi.fn(async () => "conflict" as const),
      claimNext: vi.fn(async () => ({ ...event, attemptCount: 20 })),
      releaseForRetry: vi.fn(async () => "dead_lettered" as const)
    });
    await expect(new PaymentWebhookWorker(deadStore, "worker-1").runOnce())
      .resolves.toEqual({ outcome: "dead_lettered", receiptId: "receipt-1" });
  });

  it("returns idle when no due event is available and validates worker configuration", async () => {
    const store = makeStore({ claimNext: vi.fn(async () => null) });
    await expect(new PaymentWebhookWorker(store, "worker-1").runOnce()).resolves.toEqual({ outcome: "idle" });
    expect(() => new PaymentWebhookWorker(store, "bad worker")).toThrow("INVALID_PAYMENT_WEBHOOK_WORKER_CONFIGURATION");
  });
});
