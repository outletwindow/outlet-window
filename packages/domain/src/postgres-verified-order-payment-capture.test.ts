import { describe, expect, it, vi } from "vitest";
import type { PostgresPool } from "./postgres-iam-store.js";
import { PostgresVerifiedOrderPaymentCaptureStore } from "./postgres-verified-order-payment-capture.js";

const input = {
  tenantId: "tenant-1", orderId: "order-1", providerKey: "psp-a",
  providerEventId: "evt-1", providerPaymentReference: "pay-1",
  amountMinor: 12500, currency: "SAR", capturedAtUtc: "2026-11-09T11:59:00.000Z",
  idempotencyKey: "psp-a:evt-1"
};

describe("PostgreSQL verified order payment capture store", () => {
  it("inserts a new verified capture with server-generated identity", async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => sql.includes("INSERT")
      ? { rows: [{ id: "capture-1" }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const pool = { query, connect: vi.fn() } as unknown as PostgresPool;
    const store = new PostgresVerifiedOrderPaymentCaptureStore(pool, () => "capture-1");
    await expect(store.recordVerifiedCapture(input))
      .resolves.toEqual({ outcome: "inserted", captureId: "capture-1" });
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT DO NOTHING");
    expect(query.mock.calls[0]?.[1]?.[0]).toBe("capture-1");
  });

  it("treats the exact same event and values as an idempotent replay", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: "capture-1", tenant_id: input.tenantId, order_id: input.orderId,
        provider_key: input.providerKey, provider_event_id: input.providerEventId,
        provider_payment_reference: input.providerPaymentReference, amount_minor: "12500",
        currency: "SAR", captured_at: new Date(input.capturedAtUtc),
        idempotency_key: input.idempotencyKey
      }], rowCount: 1 });
    const store = new PostgresVerifiedOrderPaymentCaptureStore(
      { query, connect: vi.fn() } as unknown as PostgresPool, () => "capture-2"
    );
    await expect(store.recordVerifiedCapture(input))
      .resolves.toEqual({ outcome: "duplicate", captureId: "capture-1" });
  });

  it("detects reused provider event identity with different payment values", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: "capture-1", tenant_id: input.tenantId, order_id: input.orderId,
        provider_key: input.providerKey, provider_event_id: input.providerEventId,
        provider_payment_reference: input.providerPaymentReference, amount_minor: "12000",
        currency: "SAR", captured_at: new Date(input.capturedAtUtc),
        idempotency_key: input.idempotencyKey
      }], rowCount: 1 });
    const store = new PostgresVerifiedOrderPaymentCaptureStore(
      { query, connect: vi.fn() } as unknown as PostgresPool
    );
    await expect(store.recordVerifiedCapture(input)).resolves.toEqual({ outcome: "identity_collision" });
  });

  it("rejects malformed or unsafe evidence before database access", async () => {
    const query = vi.fn();
    const store = new PostgresVerifiedOrderPaymentCaptureStore(
      { query, connect: vi.fn() } as unknown as PostgresPool
    );
    await expect(store.recordVerifiedCapture({ ...input, amountMinor: Number.NaN }))
      .rejects.toThrow("INVALID_VERIFIED_ORDER_PAYMENT_CAPTURE");
    expect(query).not.toHaveBeenCalled();
  });
});
