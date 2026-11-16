import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PostgresPool } from "./postgres-iam-store.js";
import { PostgresPaymentWebhookInbox } from "./postgres-payment-webhook-inbox.js";

function poolWithQuery(handler: (sql: string, values?: readonly unknown[]) => { rows: unknown[]; rowCount: number }) {
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => handler(sql, values));
  return { pool: { query, connect: vi.fn() } as unknown as PostgresPool, query };
}

describe("PostgreSQL payment webhook inbox", () => {
  it("persists only a digest and recognizes an identical provider event as a duplicate", async () => {
    const digest = createHash("sha256").update("{\"id\":\"evt-1\"}").digest("hex");
    const mock = poolWithQuery((sql) => sql.includes("INSERT")
      ? { rows: [{ id: "receipt-1" }], rowCount: 1 }
      : { rows: [{ id: "receipt-1", payload_sha256: digest }], rowCount: 1 });
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.record({ providerKey: "psp-a", providerEventId: "evt-1", rawBody: "{\"id\":\"evt-1\"}" }))
      .resolves.toEqual({ outcome: "received", receiptId: "receipt-1" });
    mock.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }))
      .mockImplementationOnce(async () => ({ rows: [{ id: "receipt-1", payload_sha256: digest }], rowCount: 1 }));
    await expect(inbox.record({ providerKey: "psp-a", providerEventId: "evt-1", rawBody: "{\"id\":\"evt-1\"}" }))
      .resolves.toEqual({ outcome: "duplicate", receiptId: "receipt-1" });
    expect(mock.query.mock.calls[0]?.[1]?.[3]).toBe(digest);
  });

  it("detects a reused provider event ID with a different payload digest", async () => {
    const mock = poolWithQuery((sql) => sql.includes("INSERT")
      ? { rows: [], rowCount: 0 }
      : { rows: [{ id: "receipt-1", payload_sha256: "0".repeat(64) }], rowCount: 1 });
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.record({ providerKey: "psp-a", providerEventId: "evt-1", rawBody: "different-body" }))
      .resolves.toEqual({ outcome: "event_id_collision" });
  });

  it("claims a receipt once and finalizes only a claimed receipt", async () => {
    const mock = poolWithQuery((sql) => ({ rows: sql.includes("RETURNING") ? [{ id: "receipt-1" }] : [], rowCount: sql.includes("RETURNING") ? 1 : 0 }));
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.claim("receipt-1")).resolves.toBe("claimed");
    await expect(inbox.finalize({ receiptId: "receipt-1", status: "applied", adjustmentId: "adjustment-1" }))
      .resolves.toBe("finalized");
    expect(mock.query.mock.calls[0]?.[0]).toContain("status='received'");
    expect(mock.query.mock.calls[1]?.[0]).toContain("status='processing'");
  });

  it("does not finalize a receipt after its worker lease expires", async () => {
    const mock = poolWithQuery(() => ({ rows: [], rowCount: 0 }));
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.finalize({
      receiptId: "receipt-1", status: "applied", workerId: "worker-1"
    })).resolves.toBe("not_processing");
    expect(mock.query.mock.calls[0]?.[0]).toContain("lease_expires_at > now()");
  });

  it("does not reschedule a receipt after its worker lease expires", async () => {
    const mock = poolWithQuery(() => ({ rows: [], rowCount: 0 }));
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.releaseForRetry({
      receiptId: "receipt-1", workerId: "worker-1", delaySeconds: 5, failureCode: "RETRY"
    })).resolves.toBe("lease_lost");
    expect(mock.query.mock.calls[0]?.[0]).toContain("lease_expires_at > now()");
  });

  it("rejects adjustment reconciliation when the worker lease has expired", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      return { rows: [{
        id: "receipt-1", adjustment_id: "adjustment-1", status: "processing",
        lease_owner: "worker-1", lease_valid: false
      }], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as PostgresPool;
    const inbox = new PostgresPaymentWebhookInbox(pool);
    await expect(inbox.reconcileAdjustment({
      receiptId: "receipt-1", adjustmentId: "adjustment-1", providerKey: "psp-a", actorId: "worker-1",
      workerId: "worker-1", confirmed: false
    })).resolves.toBe("not_processing");
    expect(clientQuery.mock.calls[1]?.[0]).toContain("lease_expires_at > now()");
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects malformed identifiers and oversized payloads", async () => {
    const mock = poolWithQuery(() => ({ rows: [], rowCount: 0 }));
    const inbox = new PostgresPaymentWebhookInbox(mock.pool);
    await expect(inbox.record({ providerKey: "psp/a", providerEventId: "evt-1", rawBody: "{}" }))
      .rejects.toThrow("INVALID_PAYMENT_WEBHOOK_RECEIPT");
    await expect(inbox.record({ providerKey: "psp-a", providerEventId: "evt-1", rawBody: "x".repeat(65_537) }))
      .rejects.toThrow("INVALID_PAYMENT_WEBHOOK_RECEIPT");
    await expect(inbox.claim("../receipt")).rejects.toThrow("INVALID_PAYMENT_WEBHOOK_RECEIPT_ID");
  });
});
