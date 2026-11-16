import { describe, expect, it, vi } from "vitest";
import type { PostgresPool } from "./postgres-iam-store.js";
import { PostgresCheckoutRecoveryCaseStore } from "./postgres-checkout-recovery-case-store.js";

const input = {
  tenantId: "tenant-1",
  orderId: "order-1",
  idempotencyKey: "checkout-recovery:order-1:1",
  failureCode: "INVENTORY_UNAVAILABLE" as const,
  failedSuborderId: "suborder-2",
  paymentReference: "capture-1",
  paymentCapturedAtUtc: "2026-11-09T12:00:00.000Z",
  reservationReferences: [{ suborderId: "suborder-1", reservationReference: "reservation-1" }]
};

function storeWith(query: ReturnType<typeof vi.fn>) {
  return new PostgresCheckoutRecoveryCaseStore(
    { query, connect: vi.fn() } as unknown as PostgresPool,
    () => "recovery-1"
  );
}

describe("PostgresCheckoutRecoveryCaseStore", () => {
  it("persists a new recovery case idempotently", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "recovery-1" }], rowCount: 1 });
    await expect(storeWith(query).record(input)).resolves.toEqual({
      outcome: "recorded", caseId: "recovery-1"
    });
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
  });

  it("returns duplicate when the complete recovery identity matches", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: "recovery-1", tenant_id: input.tenantId, order_id: input.orderId,
        failure_code: input.failureCode, failed_suborder_id: input.failedSuborderId,
        payment_reference: input.paymentReference,
        payment_captured_at: new Date(input.paymentCapturedAtUtc),
        reservation_references: input.reservationReferences
      }], rowCount: 1 });
    await expect(storeWith(query).record(input)).resolves.toEqual({
      outcome: "duplicate", caseId: "recovery-1"
    });
  });

  it("rejects idempotency-key reuse with different recovery evidence", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: "recovery-1", tenant_id: input.tenantId, order_id: input.orderId,
        failure_code: input.failureCode, failed_suborder_id: input.failedSuborderId,
        payment_reference: input.paymentReference,
        payment_captured_at: new Date(input.paymentCapturedAtUtc),
        reservation_references: []
      }], rowCount: 1 });
    await expect(storeWith(query).record(input)).resolves.toEqual({ outcome: "identity_collision" });
  });

  it("rejects invalid recovery evidence before database access", async () => {
    const query = vi.fn();
    await expect(storeWith(query).record({ ...input, paymentReference: " " }))
      .rejects.toThrow("INVALID_CHECKOUT_RECOVERY_CASE");
    expect(query).not.toHaveBeenCalled();
  });
});
