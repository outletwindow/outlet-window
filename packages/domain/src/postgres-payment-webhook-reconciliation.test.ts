import { describe, expect, it, vi } from "vitest";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";
import { PostgresPaymentWebhookInbox } from "./postgres-payment-webhook-inbox.js";

function makePool(options: { receiptStatus?: string; receiptAdjustmentId?: string | null; adjustmentStatus?: string; orderRowCount?: number } = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes("SELECT id,adjustment_id,status FROM payment_provider_webhook_events")) {
      return { rows: [{ id: "receipt-1", adjustment_id: options.receiptAdjustmentId ?? "adjustment-1", status: options.receiptStatus ?? "processing" }], rowCount: 1 };
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
      receiptId: "receipt-1", adjustmentId: "adjustment-1", actorId: "payment-worker",
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
      receiptId: "receipt-1", adjustmentId: "adjustment-1", actorId: "payment-worker",
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
      receiptId: "receipt-1", adjustmentId: "adjustment-1", actorId: "payment-worker",
      confirmed: true, providerReference: "psp-ref-123"
    })).resolves.toBe("conflict");
    expect(mock.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(mock.calls.some(call => call.sql.includes("status='applied'"))).toBe(false);
  });

  it("does not process a receipt that is not in processing state", async () => {
    const mock = makePool({ receiptStatus: "received" });
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.reconcileAdjustment({
      receiptId: "receipt-1", adjustmentId: "adjustment-1", actorId: "payment-worker",
      confirmed: true, providerReference: "psp-ref-123"
    })).resolves.toBe("not_processing");
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rejects a receipt linked to a different adjustment", async () => {
    const mock = makePool({ receiptAdjustmentId: "other-adjustment" });
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.reconcileAdjustment({
      receiptId: "receipt-1", adjustmentId: "adjustment-1", actorId: "payment-worker",
      confirmed: true, providerReference: "psp-ref-123"
    })).resolves.toBe("conflict");
    expect(mock.calls.some(call => call.sql.includes("SELECT id,tenant_id,order_id"))).toBe(false);
  });
});
