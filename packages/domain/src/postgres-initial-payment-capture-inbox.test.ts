import { describe, expect, it, vi } from "vitest";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";
import { PostgresInitialPaymentCaptureInbox, InitialPaymentCaptureWebhookWorker } from "./postgres-initial-payment-capture-inbox.js";

const base = {
  providerKey: "psp-a", providerEventId: "evt-1", paymentIntentId: "intent-1",
  rawBody: "{\"id\":\"evt-1\"}", providerPaymentReference: "pay-1",
  amountMinor: 12500, currency: "SAR", capturedAtUtc: "2026-11-09T12:00:00.000Z"
};

function poolWithQuery(query: ReturnType<typeof vi.fn>): PostgresPool {
  return { query, connect: vi.fn() } as unknown as PostgresPool;
}

describe("PostgresInitialPaymentCaptureInbox", () => {
  it("records a verified event with a server-generated receipt id", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "receipt-1" }], rowCount: 1 });
    const store = new PostgresInitialPaymentCaptureInbox(poolWithQuery(query), () => "receipt-1");
    await expect(store.recordVerified(base)).resolves.toEqual({ outcome: "received", receiptId: "receipt-1" });
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (provider_key,provider_event_id) DO NOTHING");
  });

  it("returns duplicate only when the complete event identity and raw payload match", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: "receipt-1", payment_intent_id: base.paymentIntentId,
        payload_sha256: "b2b1b4f2e6c2d2f6f0b3d1f9d3e1b7a4c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5",
        provider_payment_reference: base.providerPaymentReference, amount_minor: "12500",
        currency: "SAR", captured_at: new Date(base.capturedAtUtc)
      }], rowCount: 1 });
    // Compute the exact digest through a prior insertion and reuse its stored values.
    const crypto = await import("node:crypto");
    const digest = crypto.createHash("sha256").update(base.rawBody, "utf8").digest("hex");
    query.mockReset()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: "receipt-1", payment_intent_id: base.paymentIntentId, payload_sha256: digest,
        provider_payment_reference: base.providerPaymentReference, amount_minor: "12500",
        currency: "SAR", captured_at: new Date(base.capturedAtUtc)
      }], rowCount: 1 });
    const store = new PostgresInitialPaymentCaptureInbox(poolWithQuery(query));
    await expect(store.recordVerified(base)).resolves.toEqual({ outcome: "duplicate", receiptId: "receipt-1" });
  });

  it("rejects a reused provider event id when payload identity differs", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: "receipt-1", payment_intent_id: base.paymentIntentId, payload_sha256: "0".repeat(64),
        provider_payment_reference: base.providerPaymentReference, amount_minor: "12500",
        currency: "SAR", captured_at: new Date(base.capturedAtUtc)
      }], rowCount: 1 });
    const store = new PostgresInitialPaymentCaptureInbox(poolWithQuery(query));
    await expect(store.recordVerified(base)).resolves.toEqual({ outcome: "event_id_collision" });
  });

  it("rejects malformed capture evidence before database access", async () => {
    const query = vi.fn();
    const store = new PostgresInitialPaymentCaptureInbox(poolWithQuery(query));
    await expect(store.recordVerified({ ...base, amountMinor: 0 })).rejects.toThrow("INVALID_INITIAL_CAPTURE_WEBHOOK_RECEIPT");
    expect(query).not.toHaveBeenCalled();
  });

  it("marks ambiguous capture-ledger identities as a terminal conflict", async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [{
        id: "receipt-1", provider_key: "psp-a", provider_event_id: "evt-1",
        payment_intent_id: "intent-1", provider_payment_reference: "pay-1",
        amount_minor: "12500", currency: "SAR", captured_at: new Date(base.capturedAtUtc),
        attempt_count: 1, status: "processing", lease_owner: "worker-1", lease_valid: true
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{
        tenant_id: "tenant-1", order_id: "order-1", provider_key: "psp-a",
        provider_payment_reference: "pay-1", amount_minor: "12500", currency: "SAR",
        created_at: new Date("2026-11-09T11:00:00.000Z"),
        expires_at: new Date("2026-11-09T13:00:00.000Z"), order_status: "awaiting_payment"
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // capture insert conflict
      .mockResolvedValueOnce({ rows: [
        { id: "capture-event", tenant_id: "tenant-1", order_id: "order-1" },
        { id: "capture-key", tenant_id: "tenant-1", order_id: "order-other" }
      ], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // fail receipt
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    const client = { query: clientQuery, release: vi.fn() } as unknown as PostgresClient;
    const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } as unknown as PostgresPool;
    const store = new PostgresInitialPaymentCaptureInbox(pool);
    await expect(store.applyClaimed({ receiptId: "receipt-1", workerId: "worker-1" })).resolves.toBe("conflict");
    expect(clientQuery.mock.calls.some(call =>
      String(call[0]).includes("failure_code=$2") && call[1]?.[1] === "CAPTURE_IDENTITY_COLLISION"
    )).toBe(true);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });


  it("accepts a provider-confirmed capture completed after the intent fulfillment deadline", async () => {
    const capturedAt = new Date("2026-11-09T14:30:00.000Z");
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [{
        id: "receipt-1", provider_key: "psp-a", provider_event_id: "evt-1",
        payment_intent_id: "intent-1", provider_payment_reference: "pay-1",
        amount_minor: "12500", currency: "SAR", captured_at: capturedAt,
        attempt_count: 1, status: "processing", lease_owner: "worker-1", lease_valid: true
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{
        tenant_id: "tenant-1", order_id: "order-1", provider_key: "psp-a",
        provider_payment_reference: "pay-1", amount_minor: "12500", currency: "SAR",
        created_at: new Date("2026-11-09T11:00:00.000Z"),
        order_status: "awaiting_payment"
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "capture-1" }], rowCount: 1 }) // capture evidence
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // finalize receipt
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    const client = { query: clientQuery, release: vi.fn() } as unknown as PostgresClient;
    const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } as unknown as PostgresPool;
    const store = new PostgresInitialPaymentCaptureInbox(pool);

    await expect(store.applyClaimed({ receiptId: "receipt-1", workerId: "worker-1" }))
      .resolves.toBe("applied");
    const intentLookup = String(clientQuery.mock.calls[2]?.[0]);
    expect(intentLookup).not.toContain("expires_at");
    expect(clientQuery.mock.calls[3]?.[0]).toContain("INSERT INTO verified_order_payment_captures");
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("does not apply a receipt after its processing lease expires", async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [{
        id: "receipt-1", provider_key: "psp-a", provider_event_id: "evt-1",
        payment_intent_id: "intent-1", provider_payment_reference: "pay-1",
        amount_minor: "12500", currency: "SAR", captured_at: new Date(base.capturedAtUtc),
        attempt_count: 1, status: "processing", lease_owner: "worker-1", lease_valid: false
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
    const client = { query: clientQuery, release: vi.fn() } as unknown as PostgresClient;
    const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } as unknown as PostgresPool;
    const store = new PostgresInitialPaymentCaptureInbox(pool);
    await expect(store.applyClaimed({ receiptId: "receipt-1", workerId: "worker-1" })).resolves.toBe("lease_lost");
    expect(clientQuery).toHaveBeenCalledTimes(3);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("does not let an expired worker lease reschedule a receipt", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const store = new PostgresInitialPaymentCaptureInbox(poolWithQuery(query));
    await expect(store.releaseForRetry({
      receiptId: "receipt-1", workerId: "worker-1", delaySeconds: 10,
      failureCode: "CAPTURE_RECONCILIATION_RETRY"
    })).resolves.toBe("lease_lost");
    expect(query.mock.calls[0]?.[0]).toContain("lease_expires_at>now()");
  });

  it("reschedules transient worker failures with bounded retry metadata", async () => {
    const store = {
      claimNext: vi.fn().mockResolvedValue({ receiptId: "receipt-1", attemptCount: 2 }),
      applyClaimed: vi.fn().mockRejectedValue(new Error("database unavailable")),
      releaseForRetry: vi.fn().mockResolvedValue("rescheduled")
    } as unknown as PostgresInitialPaymentCaptureInbox;
    const worker = new InitialPaymentCaptureWebhookWorker(store, "worker-1");
    await expect(worker.runOnce()).resolves.toEqual({ outcome: "retry_scheduled", receiptId: "receipt-1" });
    expect(store.releaseForRetry).toHaveBeenCalledWith({
      receiptId: "receipt-1", workerId: "worker-1", delaySeconds: 10,
      failureCode: "CAPTURE_RECONCILIATION_RETRY"
    });
  });
});
