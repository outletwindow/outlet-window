import { describe, expect, it, vi } from "vitest";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";
import { PostgresPaymentWebhookInbox } from "./postgres-payment-webhook-inbox.js";

function makePool(options: { receiptStatus?: string; receiptAdjustmentId?: string | null; adjustmentStatus?: string; orderRowCount?: number } = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, ...(values === undefined ? {} : { values }) });
    if (sql.includes("SELECT id,adjustment_id,status FROM payment_provider_webhook_events")) {
      return { rows: [{ id: "receipt-1", adjustment_id: options.receiptAdjustmentId ?? "adjustment-1", status: options.receiptStatus ?? "processing", lease_owner: "worker-1" }], rowCount: 1 };
    }
    if (sql.includes("SELECT id,tenant_id,order_id,customer_id,currency,previous_total_minor,proposed_total_minor,status FROM customer_payment_adjustments")) {
      return { rows: [{
        id: "adjustment-1", tenant_id: "tenant-1", order_id: "order-1", customer_id: "customer-1",
        currency: "SAR", previous_total_minor: "10000", proposed_total_minor: "12000",
        status: options.adjustmentStatus ?? "provider_pending"
      }], rowCount: 1 };
    }
    if (sql.includes("UPDATE customer_orders")) {
      return { rows: [], rowCount: options.orderRowCount ?? 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() } as unknown as PostgresClient;
  const pool = { query, connect: vi.fn(async () => client) } as unknown as PostgresPool;
  return { pool, calls, query, client };
}

describe("atomic payment webhook reconciliation", () => {
  it("updates the order, adjustment event, and inbox receipt in one transaction after provider confirmation", async () => {
    const mock = makePool();
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.reconcileAdjustment({
      receiptId: "receipt-1", adjustmentId: "adjustment-1", actorId: "payment-worker", workerId: "worker-1",
      confirmed: true, providerReference: "psp-ref-123"
    })).resolves.toBe("applied");
    expect(mock.calls[0]?.sql).toBe("BEGIN");
    expect(mock.calls.some(call => call.sql.includes("UPDATE customer_orders"))).toBe(true);
    expect(mock.calls.some(call => call.sql.includes("UPDATE customer_payment_adjustments SET status='provider_confirmed'"))).toBe(true);
    expect(mock.calls.some(call => call.sql.includes("INSERT INTO customer_payment_adjustment_events"))).toBe(true);
    expect(mock.calls.some(call => call.sql.includes("UPDATE payment_provider_webhook_events SET status='applied'"))).toBe(true);
    expect(mock.calls.at(-1)?.sql).toBe("COMMIT");
    expect(mock.client.release).toHaveBeenCalledOnce();
  });

  it("records provider failure without changing the order total", async () => {
    const mock = makePool();
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.reconcileAdjustment({
      receiptId: "receipt-1", adjustmentId: "adjustment-1", actorId: "payment-worker", workerId: "worker-1",
      confirmed: false, failureCode: "PAYMENT_DECLINED"
    })).resolves.toBe("failed");
    expect(mock.calls.some(call => call.sql.includes("UPDATE customer_orders"))).toBe(false);
    expect(mock.calls.some(call => call.sql.includes("status='provider_failed'"))).toBe(true);
    expect(mock.calls.some(call => call.sql.includes("status='failed',processed_at"))).toBe(true);
    expect(mock.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("rolls back when the order changed after the adjustment was created", async () => {
    const mock = makePool({ orderRowCount: 0 });
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.reconcileAdjustment({
      receiptId: "receipt-1", adjustmentId: "adjustment-1", actorId: "payment-worker", workerId: "worker-1",
      confirmed: true, providerReference: "psp-ref-123"
    })).resolves.toBe("conflict");
    expect(mock.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(mock.calls.some(call => call.sql.includes("status='applied'"))).toBe(false);
  });

  it("does not process a receipt that is not in processing state", async () => {
    const mock = makePool({ receiptStatus: "received" });
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.reconcileAdjustment({
      receiptId: "receipt-1", adjustmentId: "adjustment-1", actorId: "payment-worker", workerId: "worker-1",
      confirmed: true, providerReference: "psp-ref-123"
    })).resolves.toBe("not_processing");
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rejects a receipt linked to a different adjustment", async () => {
    const mock = makePool({ receiptAdjustmentId: "other-adjustment" });
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.reconcileAdjustment({
      receiptId: "receipt-1", adjustmentId: "adjustment-1", actorId: "payment-worker", workerId: "worker-1",
      confirmed: true, providerReference: "psp-ref-123"
    })).resolves.toBe("conflict");
    expect(mock.calls.some(call => call.sql.includes("SELECT id,tenant_id,order_id"))).toBe(false);
  });
});

describe("payment webhook lease recovery", () => {
  it("claims one due event with a bounded lease and returns only normalized metadata", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [{
        id: "receipt-lease-1", provider_key: "psp-a", provider_event_id: "evt-lease-1",
        adjustment_id: "adjustment-1", event_type: "payment.adjustment",
        normalized_status: "succeeded" as const, provider_reference: "psp-ref-1",
        failure_code: null, attempt_count: 1
      }], rowCount: 1
    }));
    const pool = { query, connect: vi.fn() } as unknown as PostgresPool;
    const inbox = new PostgresPaymentWebhookInbox(pool);
    await expect(inbox.claimNext("worker-1", 30)).resolves.toMatchObject({
      receiptId: "receipt-lease-1", providerKey: "psp-a",
      normalizedStatus: "succeeded", attemptCount: 1
    });
    expect(query.mock.calls[0]?.[0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(query.mock.calls[0]?.[0]).toContain("lease_expires_at <= now()");
  });

  it("reschedules recoverable errors and dead-letters after the bounded attempt limit", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "receipt-lease-1", attempt_count: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "receipt-lease-2", attempt_count: 20 }], rowCount: 1 });
    const pool = { query, connect: vi.fn() } as unknown as PostgresPool;
    const inbox = new PostgresPaymentWebhookInbox(pool);
    await expect(inbox.releaseForRetry({
      receiptId: "receipt-lease-1", workerId: "worker-1", delaySeconds: 30,
      failureCode: "PROVIDER_TEMPORARY_ERROR"
    })).resolves.toBe("rescheduled");
    await expect(inbox.releaseForRetry({
      receiptId: "receipt-lease-2", workerId: "worker-1", delaySeconds: 30,
      failureCode: "PROVIDER_TEMPORARY_ERROR"
    })).resolves.toBe("dead_lettered");
    expect(query.mock.calls[0]?.[0]).toContain("lease_owner=$2");
    expect(query.mock.calls[0]?.[0]).toContain("attempt_count >= 20");
  });

  it("rejects invalid lease and retry settings", async () => {
    const query = vi.fn();
    const pool = { query, connect: vi.fn() } as unknown as PostgresPool;
    const inbox = new PostgresPaymentWebhookInbox(pool);
    await expect(inbox.claimNext("worker-1", 2)).rejects.toThrow("INVALID_PAYMENT_WEBHOOK_LEASE");
    await expect(inbox.releaseForRetry({
      receiptId: "receipt-1", workerId: "worker-1", delaySeconds: 0, failureCode: "RETRY"
    })).rejects.toThrow("INVALID_PAYMENT_WEBHOOK_RETRY");
    expect(query).not.toHaveBeenCalled();
  });
});
