import { describe, expect, it, vi } from "vitest";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";
import { PostgresPaymentAdjustmentStore } from "./postgres-payment-adjustment-store.js";

const adjustment = {
  id: "adjustment-1", tenant_id: "tenant-1", order_id: "order-1",
  customer_id: "customer-1", currency: "SAR", adjustment_direction: "refund" as const,
  amount_minor: "2500", previous_total_minor: "10000", proposed_total_minor: "7500",
  status: "provider_pending", expires_at: "2026-11-16T18:00:00.000Z",
  provider_key: "moyasar", provider_reference: "pay_ref_123"
};

function makeStore(options: { providerKey?: string; providerReference?: string; orderRowCount?: number; status?: string; captureExists?: boolean } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, ...(params === undefined ? {} : { params }) });
    if (sql.startsWith("SELECT total_minor,currency FROM customer_orders")) {
      return { rows: [{ total_minor: "10000", currency: "SAR" }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO customer_payment_adjustments")) {
      return { rows: [{ id: "adjustment-created" }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM customer_payment_adjustments")) {
      return {
        rows: [{
          ...adjustment,
          status: options.status ?? adjustment.status,
          provider_key: options.providerKey ?? adjustment.provider_key,
          provider_reference: options.providerReference ?? adjustment.provider_reference
        }],
        rowCount: 1
      };
    }
    if (sql.includes("FROM verified_order_payment_captures")) {
      return options.captureExists === false ? { rows: [], rowCount: 0 } : { rows: [{ ok: 1 }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE customer_orders")) {
      return { rows: [], rowCount: options.orderRowCount ?? 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() } as unknown as PostgresClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as PostgresPool;
  return { store: new PostgresPaymentAdjustmentStore(pool, () => new Date("2026-11-16T17:00:00.000Z")), calls, query };
}

describe("Postgres payment adjustment intent allocations", () => {
  const baseInput = {
    tenantId: "tenant-1", orderId: "order-1", customerId: "customer-1", actorId: "customer-1",
    idempotencyKey: "refund-create-key-1", quoteReference: "refund-quote-1", currency: "SAR",
    previousTotalMinor: 10000, proposedTotalMinor: 7500,
    expiresAtUtc: "2026-11-16T17:05:00.000Z"
  };

  it("requires component allocations for every refund intent", async () => {
    const { store, calls } = makeStore();
    await expect(store.createIntent(baseInput)).rejects.toThrow("refund_component_allocation_required");
    expect(calls).toHaveLength(0);
  });

  it("rejects allocations whose sum differs from the refund amount", async () => {
    const { store, calls } = makeStore();
    await expect(store.createIntent({
      ...baseInput,
      refundAllocations: [{ suborderId: "sub-1", componentKind: "product_subtotal", amountMinor: 2499 }]
    })).rejects.toThrow("refund_component_allocation_total_mismatch");
    expect(calls).toHaveLength(0);
  });

  it("persists exact allocations in the same transaction as the refund intent", async () => {
    const { store, calls } = makeStore();
    await expect(store.createIntent({
      ...baseInput,
      refundAllocations: [
        { suborderId: "sub-1", componentKind: "product_subtotal", amountMinor: 1500 },
        { suborderId: "sub-2", componentKind: "delivery", sourceReference: "delivery-quote-2", amountMinor: 1000 }
      ]
    })).resolves.toMatchObject({
      outcome: "created", adjustmentId: expect.any(String), amountMinor: 2500, direction: "refund"
    });
    const allocationInserts = calls.filter(call => call.sql.includes("INSERT INTO customer_payment_adjustment_allocations"));
    expect(allocationInserts).toHaveLength(2);
    expect(allocationInserts[1]?.params?.[2]).toBe(allocationInserts[0]?.params?.[2]);
    expect(allocationInserts[0]?.params).toEqual([
      expect.any(String), "tenant-1", expect.any(String), "order-1", "sub-1",
      "product_subtotal", null, 1500, "SAR"
    ]);
    expect(allocationInserts[1]?.params).toEqual([
      expect.any(String), "tenant-1", expect.any(String), "order-1", "sub-2",
      "delivery", "delivery-quote-2", 1000, "SAR"
    ]);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("rejects duplicate source lines before opening a transaction", async () => {
    const { store, calls } = makeStore();
    await expect(store.createIntent({
      ...baseInput,
      refundAllocations: [
        { suborderId: "sub-1", componentKind: "product_subtotal", amountMinor: 1000 },
        { suborderId: "sub-1", componentKind: "product_subtotal", amountMinor: 1500 }
      ]
    })).rejects.toThrow("duplicate_refund_component_allocation");
    expect(calls).toHaveLength(0);
  });
});

describe("Postgres payment adjustment provider result", () => {
  it("applies a provider-confirmed refund atomically against the exact previous order total", async () => {
    const { store, calls } = makeStore();
    await expect(store.recordProviderResult({
      tenantId: "tenant-1", adjustmentId: "adjustment-1", actorId: "worker-1",
      providerKey: "moyasar", confirmed: true, providerReference: "pay_ref_123"
    })).resolves.toEqual({ outcome: "provider_confirmed" });

    const orderUpdate = calls.find(call => call.sql.startsWith("UPDATE customer_orders"));
    expect(orderUpdate?.params).toEqual([
      "tenant-1", "order-1", "customer-1", "7500",
      "2026-11-16T17:00:00.000Z", "10000", "SAR"
    ]);
    expect(calls.some(call => call.sql.includes("status='provider_confirmed'"))).toBe(true);
    expect(calls.some(call => call.sql === "COMMIT")).toBe(true);
    expect(calls.some(call => call.sql === "ROLLBACK")).toBe(false);
  });

  it("does not change the order or adjustment when the provider identity does not match", async () => {
    const { store, calls } = makeStore({ providerKey: "tap" });
    await expect(store.recordProviderResult({
      tenantId: "tenant-1", adjustmentId: "adjustment-1", actorId: "worker-1",
      providerKey: "moyasar", confirmed: true, providerReference: "pay_ref_123"
    })).resolves.toEqual({ outcome: "conflict" });

    expect(calls.some(call => call.sql.startsWith("UPDATE customer_orders"))).toBe(false);
    expect(calls.some(call => call.sql.includes("status='provider_confirmed'"))).toBe(false);
    expect(calls.some(call => call.sql === "ROLLBACK")).toBe(true);
  });

  it("rolls back if the order total changed before provider confirmation is applied", async () => {
    const { store, calls } = makeStore({ orderRowCount: 0 });
    await expect(store.recordProviderResult({
      tenantId: "tenant-1", adjustmentId: "adjustment-1", actorId: "worker-1",
      providerKey: "moyasar", confirmed: true, providerReference: "pay_ref_123"
    })).resolves.toEqual({ outcome: "conflict" });

    expect(calls.some(call => call.sql.startsWith("UPDATE customer_orders"))).toBe(true);
    expect(calls.some(call => call.sql.includes("status='provider_confirmed'"))).toBe(false);
    expect(calls.some(call => call.sql === "ROLLBACK")).toBe(true);
  });


  it("atomically records customer consent and queues the provider submission", async () => {
    const { store, calls } = makeStore({ status: "awaiting_customer_consent" });
    await expect(store.consentAndQueue({
      adjustmentId: "adjustment-1", orderId: "order-1", customerId: "customer-1",
      providerKey: "moyasar"
    })).resolves.toMatchObject({ outcome: "provider_pending", submissionId: expect.any(String) });

    const captureLock = calls.find(call => call.sql.includes("FROM verified_order_payment_captures"));
    expect(captureLock?.sql).toContain("FOR UPDATE");
    const transition = calls.find(call => call.sql.includes("SET status='provider_pending'"));
    expect(transition?.params).toEqual([
      "tenant-1", "adjustment-1", "2026-11-16T17:00:00.000Z", "customer-1", "moyasar"
    ]);
    const queued = calls.find(call => call.sql.includes("INSERT INTO payment_adjustment_submission_outbox"));
    expect(queued?.params).toEqual([
      expect.any(String), "tenant-1", "adjustment-1", "moyasar",
      expect.stringMatching(/^adjustment-[0-9a-f-]{36}$/), "2026-11-16T17:00:00.000Z"
    ]);
    expect(calls.some(call => call.sql.includes("customer_payment_adjustment_events") && call.params?.[4] === "customer_consented")).toBe(true);
    expect(calls.some(call => call.sql.includes("customer_payment_adjustment_events") && call.params?.[4] === "provider_submission_queued")).toBe(true);
    expect(calls.some(call => call.sql === "COMMIT")).toBe(true);
    expect(calls.some(call => call.sql === "ROLLBACK")).toBe(false);
  });

  it("refuses to queue a refund without a verified original capture from the same provider", async () => {
    const { store, calls } = makeStore({ status: "awaiting_customer_consent", captureExists: false });
    await expect(store.consentAndQueue({
      adjustmentId: "adjustment-1", orderId: "order-1", customerId: "customer-1",
      providerKey: "moyasar"
    })).resolves.toEqual({ outcome: "conflict" });
    expect(calls.some(call => call.sql.includes("INSERT INTO payment_adjustment_submission_outbox"))).toBe(false);
    expect(calls.some(call => call.sql === "ROLLBACK")).toBe(true);
  });

  it("does not queue when customer consent has already been recorded", async () => {
    const { store, calls } = makeStore({ status: "consented" });
    await expect(store.consentAndQueue({
      adjustmentId: "adjustment-1", orderId: "order-1", customerId: "customer-1",
      providerKey: "moyasar"
    })).resolves.toEqual({ outcome: "conflict" });
    expect(calls.some(call => call.sql.includes("INSERT INTO payment_adjustment_submission_outbox"))).toBe(false);
    expect(calls.some(call => call.sql === "ROLLBACK")).toBe(true);
  });

  it("queues a consented adjustment with a durable idempotency key before provider submission", async () => {
    const { store, calls } = makeStore({ status: "consented" });
    await expect(store.queueProviderSubmission({
      tenantId: "tenant-1", adjustmentId: "adjustment-1", actorId: "service-1",
      providerKey: "moyasar", idempotencyKey: "refund-idempotency-123"
    })).resolves.toMatchObject({ outcome: "provider_pending", submissionId: expect.any(String) });

    const queued = calls.find(call => call.sql.includes("INSERT INTO payment_adjustment_submission_outbox"));
    expect(queued?.params).toEqual([
      expect.any(String), "tenant-1", "adjustment-1", "moyasar",
      "refund-idempotency-123", "2026-11-16T17:00:00.000Z"
    ]);
    const transition = calls.find(call => call.sql.includes("SET status='provider_pending'"));
    expect(transition?.params).toEqual([
      "tenant-1", "adjustment-1", "moyasar", "2026-11-16T17:00:00.000Z"
    ]);
    expect(calls.some(call => call.sql.includes("customer_payment_adjustment_events") && call.params?.[4] === "provider_submission_queued")).toBe(true);
    expect(calls.some(call => call.sql === "COMMIT")).toBe(true);
  });

  it("does not enqueue a second provider submission for an adjustment already pending", async () => {
    const { store, calls } = makeStore({ status: "provider_pending" });
    await expect(store.queueProviderSubmission({
      tenantId: "tenant-1", adjustmentId: "adjustment-1", actorId: "service-1",
      providerKey: "moyasar", idempotencyKey: "refund-idempotency-456"
    })).resolves.toEqual({ outcome: "conflict" });

    expect(calls.some(call => call.sql.includes("INSERT INTO payment_adjustment_submission_outbox"))).toBe(false);
    expect(calls.some(call => call.sql === "ROLLBACK")).toBe(true);
  });

  it("persists the provider identity only after customer consent", async () => {
    const { store, calls } = makeStore({ status: "consented" });
    await expect(store.markProviderPending({
      tenantId: "tenant-1", adjustmentId: "adjustment-1", actorId: "service-1",
      providerKey: "moyasar", providerReference: "refund_ref_456"
    })).resolves.toEqual({ outcome: "provider_pending" });

    const update = calls.find(call => call.sql.includes("SET status='provider_pending'"));
    expect(update?.params).toEqual([
      "tenant-1", "adjustment-1", "moyasar", "refund_ref_456",
      "2026-11-16T17:00:00.000Z"
    ]);
    expect(calls.some(call => call.sql.includes("customer_payment_adjustment_events") && call.params?.[4] === "provider_submitted")).toBe(true);
    expect(calls.some(call => call.sql === "COMMIT")).toBe(true);
  });

  it("does not permit a second provider submission for an already pending adjustment", async () => {
    const { store, calls } = makeStore({ status: "provider_pending" });
    await expect(store.markProviderPending({
      tenantId: "tenant-1", adjustmentId: "adjustment-1", actorId: "service-1",
      providerKey: "moyasar", providerReference: "refund_ref_duplicate"
    })).resolves.toEqual({ outcome: "conflict" });

    expect(calls.some(call => call.sql.includes("SET status='provider_pending'"))).toBe(false);
    expect(calls.some(call => call.sql === "ROLLBACK")).toBe(true);
  });

  it("records a provider failure without changing the order total", async () => {
    const { store, calls } = makeStore();
    await expect(store.recordProviderResult({
      tenantId: "tenant-1", adjustmentId: "adjustment-1", actorId: "worker-1",
      providerKey: "moyasar", confirmed: false
    })).resolves.toEqual({ outcome: "provider_failed" });

    expect(calls.some(call => call.sql.startsWith("UPDATE customer_orders"))).toBe(false);
    expect(calls.some(call => call.sql.includes("status='provider_failed'"))).toBe(true);
    expect(calls.some(call => call.sql === "COMMIT")).toBe(true);
  });
});


describe("customer payment adjustment read model", () => {
  it("returns only the authenticated customer's adjustment and immutable component allocations", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, ...(params === undefined ? {} : { params }) });
      if (sql.includes("FROM customer_payment_adjustments")) {
        return { rows: [{
          id: "adjustment-1", order_id: "order-1", currency: "SAR",
          adjustment_direction: "refund", amount_minor: "2500",
          previous_total_minor: "10000", proposed_total_minor: "7500",
          status: "awaiting_customer_consent", expires_at: "2026-11-16T17:05:00.000Z"
        }], rowCount: 1 };
      }
      return { rows: [{
        suborder_id: "suborder-1", merchant_id: "merchant-1", branch_id: "branch-1",
        component_kind: "product_subtotal", amount_minor: "2500", currency: "SAR"
      }], rowCount: 1 };
    });
    const pool = { query } as unknown as PostgresPool;
    const store = new PostgresPaymentAdjustmentStore(pool, () => new Date("2026-11-16T17:00:00.000Z"));
    await expect(store.getCustomerAdjustment({
      orderId: "order-1", adjustmentId: "adjustment-1", customerId: "customer-1"
    })).resolves.toEqual({
      outcome: "found",
      adjustment: {
        id: "adjustment-1", orderId: "order-1", currency: "SAR", direction: "refund",
        amountMinor: 2500, previousTotalMinor: 10000, proposedTotalMinor: 7500,
        status: "awaiting_customer_consent", expiresAtUtc: "2026-11-16T17:05:00.000Z",
        allocations: [{
          suborderId: "suborder-1", merchantId: "merchant-1", branchId: "branch-1",
          componentKind: "product_subtotal", amountMinor: 2500, currency: "SAR"
        }]
      }
    });
    expect(calls[0]?.sql).toContain("tenant_id='platform' AND id=$1 AND order_id=$2 AND customer_id=$3");
    expect(calls[0]?.params).toEqual(["adjustment-1", "order-1", "customer-1"]);
    expect(calls[1]?.sql).toContain("JOIN merchant_suborders");
    expect(calls[1]?.sql).toContain("a.order_id=$2");
    expect(calls[1]?.params).toEqual(["adjustment-1", "order-1"]);
  });

  it("rejects minor-unit values that exceed JavaScript's safe integer range", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM customer_payment_adjustments")) {
        return { rows: [{
          id: "adjustment-1", order_id: "order-1", currency: "SAR",
          adjustment_direction: "refund", amount_minor: "9007199254740992",
          previous_total_minor: "10000", proposed_total_minor: "7500",
          status: "awaiting_customer_consent", expires_at: "2026-11-16T17:05:00.000Z"
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const pool = { query } as unknown as PostgresPool;
    const store = new PostgresPaymentAdjustmentStore(pool);
    await expect(store.getCustomerAdjustment({
      orderId: "order-1", adjustmentId: "adjustment-1", customerId: "customer-1"
    })).rejects.toThrow("invalid_payment_adjustment_amount");
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain("a.order_id=$2");
  });

  it("does not disclose an adjustment when it belongs to another customer", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const pool = { query } as unknown as PostgresPool;
    const store = new PostgresPaymentAdjustmentStore(pool);
    await expect(store.getCustomerAdjustment({
      orderId: "order-1", adjustmentId: "adjustment-1", customerId: "different-customer"
    })).resolves.toEqual({ outcome: "not_found" });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
