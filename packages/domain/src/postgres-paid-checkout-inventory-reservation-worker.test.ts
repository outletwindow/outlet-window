import { describe, expect, it, vi } from "vitest";
import type { InventoryReservationPort } from "./inventory-reservation.js";
import type { PostgresPool } from "./postgres-iam-store.js";
import type { PostgresOrderTransitionStore } from "./postgres-order-transition-store.js";
import type { PostgresCheckoutRecoveryCaseStore } from "./postgres-checkout-recovery-case-store.js";
import { PostgresPaidCheckoutInventoryReservationWorker } from "./postgres-paid-checkout-inventory-reservation-worker.js";

const job = {
  id: "job-1", tenant_id: "platform", order_id: "order-1",
  capture_id: "capture-1", attempt_count: 1,
  created_at: new Date("2026-11-14T11:59:00.000Z")
};
const payment = {
  tenant_id: "platform", status: "awaiting_payment", total_minor: "12500", currency: "SAR",
  provider_payment_reference: "pay-ref-1", captured_at: new Date("2026-11-14T12:00:00.000Z"),
  capture_amount_minor: "12500", capture_currency: "SAR"
};
const suborder = {
  id: "sub-1", tenant_id: "merchant-tenant", merchant_id: "merchant-1",
  branch_id: "branch-1", status: "pending_validation", version: 1
};

function createPool(rows: {
  payment?: typeof payment | null;
  suborders?: typeof suborder[];
  lines?: { product_variant_id: string; sku: string; quantity: number }[];
} = {}) {
  const calls: string[] = [];
  const query = vi.fn(async <Row>(sql: string) => {
    calls.push(sql);
    if (sql.includes("WITH due AS")) return { rows: [job] as Row[], rowCount: 1 };
    if (sql.includes("verified_order_payment_captures")) {
      return { rows: rows.payment === null ? [] : [rows.payment ?? payment] as Row[], rowCount: rows.payment === null ? 0 : 1 };
    }
    if (sql.includes("FROM merchant_suborders")) {
      const found = rows.suborders ?? [suborder];
      return { rows: found as Row[], rowCount: found.length };
    }
    if (sql.includes("FROM customer_order_items")) {
      const found = rows.lines ?? [{ product_variant_id: "catalog-v1", sku: "SKU-1", quantity: 1 }];
      return { rows: found as Row[], rowCount: found.length };
    }
    if (sql.includes("UPDATE paid_checkout_inventory_reservation_jobs")) return { rows: [] as Row[], rowCount: 1 };
    throw new Error("UNEXPECTED_TEST_QUERY");
  });
  return { pool: { query, connect: vi.fn() } as unknown as PostgresPool, calls, query };
}

function createWorker(input: {
  pool: PostgresPool;
  inventory?: InventoryReservationPort;
  transition?: ReturnType<typeof vi.fn>;
  recovery?: ReturnType<typeof vi.fn>;
  maxAttempts?: number;
}) {
  const inventory = input.inventory ?? {
    reserveExactVariants: vi.fn().mockResolvedValue({
      outcome: "reserved", reservationReference: "reservation-1"
    })
  };
  const transition = input.transition ?? vi.fn().mockResolvedValue({
    outcome: "updated", parentStatus: "awaiting_payment",
    transition: { ok: true, previousStatus: "pending_validation", order: { status: "awaiting_payment" } }
  });
  const recovery = input.recovery ?? vi.fn().mockResolvedValue({ outcome: "recorded", caseId: "case-1" });
  const worker = new PostgresPaidCheckoutInventoryReservationWorker(
    input.pool, inventory,
    { transitionSuborder: transition } as unknown as Pick<PostgresOrderTransitionStore, "transitionSuborder">,
    { record: recovery } as unknown as Pick<PostgresCheckoutRecoveryCaseStore, "record">,
    { workerId: "worker-1", now: () => new Date("2026-11-14T12:01:00.000Z"),
      createId: () => "audit-id", ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }) }
  );
  return { worker, inventory, transition, recovery };
}

describe("PostgresPaidCheckoutInventoryReservationWorker", () => {
  it("reserves exact branch lines and transitions a paid suborder through payment to confirmed", async () => {
    const db = createPool();
    const { worker, inventory, transition, recovery } = createWorker({ pool: db.pool });
    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: "completed", jobId: "job-1" });
    expect(db.calls[0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(inventory.reserveExactVariants).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "merchant-tenant", orderId: "order-1", suborderId: "sub-1",
      idempotencyKey: "paid-checkout:platform:order-1:sub-1",
      requestedAtUtc: "2026-11-14T11:59:00.000Z",
      lines: [{ productVariantId: "catalog-v1", sku: "SKU-1", quantity: 1 }]
    }));
    expect(transition).toHaveBeenCalledTimes(2);
    expect(transition.mock.calls[0]?.[0]).toMatchObject({ nextStatus: "awaiting_payment" });
    expect(transition.mock.calls[1]?.[0]).toMatchObject({ nextStatus: "confirmed" });
    expect(recovery).not.toHaveBeenCalled();
  });

  it("reuses the immutable outbox timestamp and idempotency key after a provider retry", async () => {
    const db = createPool();
    const reserveExactVariants = vi.fn()
      .mockRejectedValueOnce(new Error("INVENTORY_PROVIDER_TRANSIENT_FAILURE"))
      .mockResolvedValueOnce({
        outcome: "reserved", reservationReference: "reservation-1"
      });
    const inventory: InventoryReservationPort = { reserveExactVariants };
    const { worker } = createWorker({ pool: db.pool, inventory });
    await expect(worker.runOnce()).resolves.toMatchObject({
      outcome: "retry_scheduled", failureCode: "INVENTORY_PROVIDER_TRANSIENT_FAILURE"
    });
    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: "completed" });
    expect(reserveExactVariants).toHaveBeenCalledTimes(2);
    const first = reserveExactVariants.mock.calls[0]?.[0];
    const retry = reserveExactVariants.mock.calls[1]?.[0];
    expect(first).toMatchObject({
      idempotencyKey: "paid-checkout:platform:order-1:sub-1",
      requestedAtUtc: "2026-11-14T11:59:00.000Z"
    });
    expect(retry).toEqual(first);
  });

  it("completes a replay for an already confirmed suborder without re-reserving consumed stock", async () => {
    const db = createPool({
      payment: { ...payment, status: "confirmed" },
      suborders: [{ ...suborder, status: "confirmed" }]
    });
    const { worker, inventory, transition } = createWorker({ pool: db.pool });
    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: "completed", jobId: "job-1" });
    expect(inventory.reserveExactVariants).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(db.calls.some(sql => sql.includes("FROM customer_order_items"))).toBe(false);
  });

  it("does not reserve inventory when the verified capture row is missing", async () => {
    const db = createPool({ payment: null });
    const { worker, inventory } = createWorker({ pool: db.pool });
    await expect(worker.runOnce()).resolves.toMatchObject({
      outcome: "retry_scheduled", failureCode: "PAID_CHECKOUT_CAPTURE_EVIDENCE_MISMATCH"
    });
    expect(inventory.reserveExactVariants).not.toHaveBeenCalled();
  });

  it("moves unpaid suborders to hold when paid order lines are missing", async () => {
    const db = createPool({
      lines: [],
      suborders: [suborder, { ...suborder, id: "sub-2", merchant_id: "merchant-2", branch_id: "branch-2" }]
    });
    const transition = vi.fn().mockResolvedValue({
      outcome: "updated", parentStatus: "on_hold",
      transition: { ok: true, previousStatus: "pending_validation", order: { status: "on_hold" } }
    });
    const { worker, inventory, recovery } = createWorker({ pool: db.pool, transition });
    await expect(worker.runOnce()).resolves.toMatchObject({
      outcome: "needs_review", failureCode: "ORDER_LINES_MISSING"
    });
    expect(inventory.reserveExactVariants).not.toHaveBeenCalled();
    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
      failureCode: "TASK_COMMIT_REJECTED", failedSuborderId: "sub-1"
    }));
    expect(transition).toHaveBeenCalledTimes(2);
    expect(transition.mock.calls.every(call => call[0].nextStatus === "on_hold")).toBe(true);
  });

  it("holds a paid order and records recovery when exact branch stock is unavailable", async () => {
    const db = createPool();
    const inventory: InventoryReservationPort = {
      reserveExactVariants: vi.fn().mockResolvedValue({
        outcome: "unavailable", unavailableLines: ["catalog-v1"]
      })
    };
    const transition = vi.fn().mockResolvedValue({
      outcome: "updated", parentStatus: "on_hold",
      transition: { ok: true, previousStatus: "pending_validation", order: { status: "on_hold" } }
    });
    const { worker, recovery } = createWorker({ pool: db.pool, inventory, transition });
    await expect(worker.runOnce()).resolves.toMatchObject({
      outcome: "needs_review", failureCode: "INVENTORY_UNAVAILABLE"
    });
    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
      failureCode: "INVENTORY_UNAVAILABLE", failedSuborderId: "sub-1"
    }));
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({
      nextStatus: "on_hold", context: expect.objectContaining({ reason: expect.any(String) })
    }));
  });

  it("holds paid orders when no merchant POS/ERP hard-reservation adapter is configured", async () => {
    const db = createPool();
    const inventory: InventoryReservationPort = {
      reserveExactVariants: vi.fn().mockResolvedValue({
        outcome: "unsupported", reason: "merchant_integration_missing"
      })
    };
    const transition = vi.fn().mockResolvedValue({
      outcome: "updated", parentStatus: "on_hold",
      transition: { ok: true, previousStatus: "pending_validation", order: { status: "on_hold" } }
    });
    const { worker, recovery } = createWorker({ pool: db.pool, inventory, transition });
    await expect(worker.runOnce()).resolves.toMatchObject({
      outcome: "needs_review", failureCode: "INVENTORY_UNGUARANTEED"
    });
    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
      failureCode: "INVENTORY_UNGUARANTEED", failedSuborderId: "sub-1"
    }));
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({
      nextStatus: "on_hold"
    }));
    expect(transition).not.toHaveBeenCalledWith(expect.objectContaining({
      nextStatus: "confirmed"
    }));
  });

  it("reserves every merchant suborder before confirming any of them", async () => {
    const db = createPool({ suborders: [suborder, { ...suborder, id: "sub-2", merchant_id: "merchant-2", branch_id: "branch-2" }] });
    const { worker, inventory, transition, recovery } = createWorker({ pool: db.pool });
    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: "completed", jobId: "job-1" });
    expect(inventory.reserveExactVariants).toHaveBeenCalledTimes(2);
    expect(inventory.reserveExactVariants).toHaveBeenNthCalledWith(2, expect.objectContaining({
      suborderId: "sub-2", merchantId: "merchant-2", branchId: "branch-2",
      idempotencyKey: "paid-checkout:platform:order-1:sub-2"
    }));
    expect(transition).toHaveBeenCalledTimes(4);
    expect(transition.mock.calls.map(call => call[0].nextStatus)).toEqual([
      "awaiting_payment", "confirmed", "awaiting_payment", "confirmed"
    ]);
    expect(recovery).not.toHaveBeenCalled();
  });

  it("records earlier branch reservations and holds every unpaid suborder when a later branch is unavailable", async () => {
    const db = createPool({ suborders: [suborder, { ...suborder, id: "sub-2", merchant_id: "merchant-2", branch_id: "branch-2" }] });
    const inventory: InventoryReservationPort = {
      reserveExactVariants: vi.fn()
        .mockResolvedValueOnce({ outcome: "reserved", reservationReference: "reservation-1" })
        .mockResolvedValueOnce({ outcome: "unavailable", unavailableLines: ["catalog-v2"] }),
      releaseExactReservation: vi.fn().mockResolvedValue({ outcome: "released" })
    };
    const transition = vi.fn().mockResolvedValue({
      outcome: "updated", parentStatus: "on_hold",
      transition: { ok: true, previousStatus: "pending_validation", order: { status: "on_hold" } }
    });
    const { worker, recovery } = createWorker({ pool: db.pool, inventory, transition });
    await expect(worker.runOnce()).resolves.toMatchObject({
      outcome: "needs_review", failureCode: "INVENTORY_UNAVAILABLE"
    });
    expect(inventory.reserveExactVariants).toHaveBeenCalledTimes(2);
    expect(inventory.releaseExactReservation).toHaveBeenCalledTimes(1);
    expect(inventory.releaseExactReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "merchant-tenant", orderId: "order-1", suborderId: "sub-1",
        merchantId: "merchant-1", branchId: "branch-1",
        idempotencyKey: "paid-checkout:platform:order-1:sub-1"
      }),
      "reservation-1",
      "2026-11-14T12:01:00.000Z"
    );
    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
      failureCode: "INVENTORY_UNAVAILABLE", failedSuborderId: "sub-2",
      reservationReferences: [{ suborderId: "sub-1", reservationReference: "reservation-1" }]
    }));
    expect(transition).toHaveBeenCalledTimes(2);
    expect(transition.mock.calls.every(call => call[0].nextStatus === "on_hold")).toBe(true);
    expect(transition).not.toHaveBeenCalledWith(expect.objectContaining({ nextStatus: "confirmed" }));
  });

  it("keeps a paid order in recovery when the originating adapter cannot release an earlier hold", async () => {
    const db = createPool({ suborders: [suborder, { ...suborder, id: "sub-2", merchant_id: "merchant-2", branch_id: "branch-2" }] });
    const inventory: InventoryReservationPort = {
      reserveExactVariants: vi.fn()
        .mockResolvedValueOnce({ outcome: "reserved", reservationReference: "reservation-1", providerIntegrationId: "pos-1" })
        .mockResolvedValueOnce({ outcome: "unavailable", unavailableLines: ["catalog-v2"] }),
      releaseExactReservation: vi.fn().mockResolvedValue({ outcome: "unsupported" })
    };
    const transition = vi.fn().mockResolvedValue({
      outcome: "updated", parentStatus: "on_hold",
      transition: { ok: true, previousStatus: "pending_validation", order: { status: "on_hold" } }
    });
    const { worker, recovery } = createWorker({ pool: db.pool, inventory, transition });
    await expect(worker.runOnce()).resolves.toMatchObject({
      outcome: "needs_review", failureCode: "INVENTORY_UNAVAILABLE"
    });
    expect(inventory.releaseExactReservation).toHaveBeenCalledWith(
      expect.objectContaining({ providerIntegrationId: "pos-1" }),
      "reservation-1",
      "2026-11-14T12:01:00.000Z"
    );
    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
      reservationReferences: [{ suborderId: "sub-1", reservationReference: "reservation-1" }]
    }));
    expect(transition.mock.calls.every(call => call[0].nextStatus === "on_hold")).toBe(true);
  });

  it("keeps the paid order on hold when compensation fails instead of replaying the reservation saga", async () => {
    const db = createPool({ suborders: [suborder, { ...suborder, id: "sub-2", merchant_id: "merchant-2", branch_id: "branch-2" }] });
    const inventory: InventoryReservationPort = {
      reserveExactVariants: vi.fn()
        .mockResolvedValueOnce({ outcome: "reserved", reservationReference: "reservation-1" })
        .mockResolvedValueOnce({ outcome: "unavailable", unavailableLines: ["catalog-v2"] }),
      releaseExactReservation: vi.fn().mockRejectedValue(new Error("PROVIDER_RELEASE_TIMEOUT"))
    };
    const transition = vi.fn().mockResolvedValue({
      outcome: "updated", parentStatus: "on_hold",
      transition: { ok: true, previousStatus: "pending_validation", order: { status: "on_hold" } }
    });
    const { worker, recovery } = createWorker({ pool: db.pool, inventory, transition });
    await expect(worker.runOnce()).resolves.toMatchObject({
      outcome: "needs_review", failureCode: "INVENTORY_UNAVAILABLE"
    });
    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
      reservationReferences: [{ suborderId: "sub-1", reservationReference: "reservation-1" }]
    }));
    expect(inventory.releaseExactReservation).toHaveBeenCalledTimes(1);
    expect(inventory.reserveExactVariants).toHaveBeenCalledTimes(2);
    expect(transition).toHaveBeenCalledTimes(2);
    expect(transition.mock.calls.every(call => call[0].nextStatus === "on_hold")).toBe(true);
  });

  it("retries terminal escalation when the durable recovery case cannot be persisted", async () => {
    const db = createPool();
    const inventory: InventoryReservationPort = {
      reserveExactVariants: vi.fn().mockRejectedValue(new Error("INVENTORY_PROVIDER_OUTCOME_UNKNOWN"))
    };
    const recovery = vi.fn().mockRejectedValue(new Error("RECOVERY_DATABASE_UNAVAILABLE"));
    const { worker, transition } = createWorker({
      pool: db.pool, inventory, recovery, maxAttempts: 1
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      outcome: "retry_scheduled", failureCode: "PAID_CHECKOUT_ESCALATION_RETRY"
    });
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(transition).not.toHaveBeenCalled();
    const jobUpdate = db.query.mock.calls.find(call =>
      String(call[0]).includes("UPDATE paid_checkout_inventory_reservation_jobs")
    );
    expect(jobUpdate?.[0]).toContain("attempt_count=CASE WHEN $7 THEN LEAST(attempt_count,$5 - 1)");
    expect(jobUpdate?.[1]?.[5]).toBe("PAID_CHECKOUT_ESCALATION_RETRY");
    expect(jobUpdate?.[1]?.[6]).toBe(true);
  });

  it("creates a recovery case and holds unpaid suborders when paid inventory retries are exhausted", async () => {
    const db = createPool();
    const inventory: InventoryReservationPort = {
      reserveExactVariants: vi.fn().mockRejectedValue(new Error("INVENTORY_PROVIDER_OUTCOME_UNKNOWN"))
    };
    const transition = vi.fn().mockResolvedValue({
      outcome: "updated", parentStatus: "on_hold",
      transition: { ok: true, previousStatus: "pending_validation", order: { status: "on_hold" } }
    });
    const { worker, recovery } = createWorker({
      pool: db.pool, inventory, transition, maxAttempts: 1
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      outcome: "dead_lettered", failureCode: "INVENTORY_PROVIDER_OUTCOME_UNKNOWN"
    });
    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({
      failureCode: "INVENTORY_UNGUARANTEED",
      reservationReferences: []
    }));
    expect(recovery.mock.calls[0]?.[0]).not.toHaveProperty("failedSuborderId");
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({
      nextStatus: "on_hold",
      context: expect.objectContaining({ reason: "Merchant inventory hard reservation is not guaranteed" })
    }));
  });

});
