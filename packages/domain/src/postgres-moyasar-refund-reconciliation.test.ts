import { describe, expect, it, vi } from "vitest";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";
import { PostgresPaymentWebhookInbox } from "./postgres-payment-webhook-inbox.js";

const paymentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const rawBody = JSON.stringify({ id: "evt-refund-1", type: "payment_refunded" });

function makePool(options: {
  insertCount?: number;
  existingDigest?: string;
  activeCount?: number;
  confirmedMinor?: string;
  refundedMinor?: number;
  orderRowCount?: number;
} = {}) {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, ...(params === undefined ? {} : { params }) });
    if (sql.includes("INSERT INTO payment_provider_webhook_events")) {
      return options.insertCount === 0 ? { rows: [], rowCount: 0 } : { rows: [{ id: "receipt-1" }], rowCount: 1 };
    }
    if (sql.includes("SELECT id,payload_sha256 FROM payment_provider_webhook_events")) {
      return { rows: [{ id: "receipt-existing", payload_sha256: options.existingDigest ?? "same-digest" }], rowCount: 1 };
    }
    if (sql.includes("FROM verified_order_payment_captures")) {
      return { rows: [{ tenant_id: "tenant-1", order_id: "order-1", amount_minor: "10000", currency: "SAR" }], rowCount: 1 };
    }
    if (sql.includes("SELECT r.adjustment_id")) {
      return options.activeCount === 0 ? { rows: [], rowCount: 0 } : { rows: [{ adjustment_id: "adjustment-1" }], rowCount: options.activeCount ?? 1 };
    }
    if (sql.includes("SELECT id FROM customer_payment_adjustments")) {
      return { rows: [{ id: "adjustment-1" }], rowCount: 1 };
    }
    if (sql.includes("SELECT r.id,r.adjustment_id")) {
      return options.activeCount === 0 ? { rows: [], rowCount: 0 } : { rows: [{
        id: "reservation-1", adjustment_id: "adjustment-1", amount_minor: "2500", status: "reserved",
        provider_key: "moyasar", provider_reference: paymentId, adjustment_status: "provider_pending",
        currency: "SAR", previous_total_minor: "10000", proposed_total_minor: "7500",
        order_id: "order-1", customer_id: "customer-1"
      }], rowCount: options.activeCount ?? 1 };
    }
    if (sql.includes("COALESCE(SUM(amount_minor),0)")) {
      return { rows: [{ total_minor: options.confirmedMinor ?? "0" }], rowCount: 1 };
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

const command = {
  providerEventId: "evt-refund-1", rawBody, providerPaymentReference: paymentId,
  refundedMinor: 2500, refundableBaseMinor: 10000, currency: "SAR",
  refundedAtUtc: "2026-11-16T17:59:00.000Z"
};

describe("atomic Moyasar cumulative refund reconciliation", () => {
  it("updates order, adjustment, reservation trigger, and receipt in one transaction", async () => {
    const mock = makePool();
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.recordAndReconcileMoyasarRefund(command)).resolves.toBe("applied");
    expect(mock.calls[0]?.sql).toBe("BEGIN");
    const adjustmentLock = mock.calls.findIndex(x => x.sql.includes("SELECT id FROM customer_payment_adjustments"));
    const captureLock = mock.calls.findIndex(x => x.sql.includes("FOR UPDATE") && x.sql.includes("verified_order_payment_captures"));
    expect(adjustmentLock).toBeGreaterThan(-1);
    expect(captureLock).toBeGreaterThan(adjustmentLock);
    expect(mock.calls.some(x => x.sql.includes("UPDATE customer_orders"))).toBe(true);
    expect(mock.calls.some(x => x.sql.includes("SET status='provider_confirmed'"))).toBe(true);
    expect(mock.calls.some(x => x.sql.includes("SET status='applied'"))).toBe(true);
    expect(mock.calls.at(-1)?.sql).toBe("COMMIT");
    expect(mock.client.release).toHaveBeenCalledOnce();
  });

  it("quarantines a cumulative amount mismatch without changing order or reservation", async () => {
    const mock = makePool({ refundedMinor: 3000 });
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.recordAndReconcileMoyasarRefund({ ...command, refundedMinor: 3000 }))
      .resolves.toBe("reconciliation_required");
    expect(mock.calls.some(x => x.sql.includes("UPDATE customer_orders"))).toBe(false);
    expect(mock.calls.some(x => x.sql.includes("status='reconciliation_required'"))).toBe(true);
    expect(mock.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("marks an already-accounted cumulative snapshot as ignored when no reservation is active", async () => {
    const mock = makePool({ activeCount: 0, confirmedMinor: "2500" });
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.recordAndReconcileMoyasarRefund(command)).resolves.toBe("ignored");
    expect(mock.calls.some(x => x.sql.includes("UPDATE customer_orders"))).toBe(false);
    expect(mock.calls.some(x => x.sql.includes("status='ignored'"))).toBe(true);
  });

  it("deduplicates identical events and detects event-id payload collisions", async () => {
    const duplicate = makePool({ insertCount: 0, existingDigest: "same-digest" });
    await expect(new PostgresPaymentWebhookInbox(duplicate.pool).recordAndReconcileMoyasarRefund(command))
      .resolves.toBe("duplicate");
    expect(duplicate.calls.some(x => x.sql.includes("verified_order_payment_captures"))).toBe(false);
    const collision = makePool({ insertCount: 0, existingDigest: "different-digest" });
    await expect(new PostgresPaymentWebhookInbox(collision.pool).recordAndReconcileMoyasarRefund(command))
      .resolves.toBe("event_id_collision");
  });

  it("quarantines order-total conflicts without marking a refund as confirmed", async () => {
    const mock = makePool({ orderRowCount: 0 });
    await expect(new PostgresPaymentWebhookInbox(mock.pool).recordAndReconcileMoyasarRefund(command))
      .resolves.toBe("reconciliation_required");
    expect(mock.calls.some(x => x.sql.includes("SET status='provider_confirmed'"))).toBe(false);
    expect(mock.calls.some(x => x.sql.includes("status='reconciliation_required'"))).toBe(true);
  });
});
