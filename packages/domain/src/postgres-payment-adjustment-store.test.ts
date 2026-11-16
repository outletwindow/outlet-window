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

function makeStore(options: { providerKey?: string; providerReference?: string; orderRowCount?: number; status?: string } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, ...(params === undefined ? {} : { params }) });
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
    if (sql.startsWith("UPDATE customer_orders")) {
      return { rows: [], rowCount: options.orderRowCount ?? 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() } as unknown as PostgresClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as PostgresPool;
  return { store: new PostgresPaymentAdjustmentStore(pool, () => new Date("2026-11-16T17:00:00.000Z")), calls, query };
}

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
    expect(calls.some(call => call.sql.includes("'provider_submitted'"))).toBe(true);
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
