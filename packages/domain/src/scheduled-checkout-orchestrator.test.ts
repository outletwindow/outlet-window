import { describe, expect, it } from "vitest";
import {
  orchestratePaidScheduledCheckout,
  type ScheduledCheckoutOrchestrationResult
} from "./scheduled-checkout-orchestrator.js";
import type { ScheduledOrderConfirmation, ScheduledOrderTransactionRunner } from "./scheduled-order-commit.js";
import type { InventoryReservationRequest, InventoryReservationPort } from "./inventory-reservation.js";
import type { ScheduledFulfillmentTaskEnvelope } from "./scheduled-fulfillment-workflow.js";

const order: ScheduledOrderConfirmation = {
  orderId: "parent-order-1", tenantId: "platform",
  paymentReference: "provider-capture-1",
  paymentCapturedAtUtc: "2026-11-08T09:00:00.000Z",
  confirmedAtUtc: "2026-11-08T09:00:00.000Z",
  fulfillmentVersion: 1
};
const plan = {
  orderId: order.orderId,
  fulfillmentType: "home_delivery" as const,
  scheduledFor: "2026-11-08T17:00:00+03:00",
  scheduledForUtc: "2026-11-08T14:00:00.000Z",
  paymentDueAt: order.paymentCapturedAtUtc,
  inventoryReservationDueAt: order.paymentCapturedAtUtc,
  preparationReleaseAtUtc: "2026-11-08T13:10:00.000Z",
  courierDispatchAtUtc: "2026-11-08T13:40:00.000Z",
  estimate: { preparationMinutes: 30, bufferMinutes: 0, travelMinutes: 20 },
  createdAt: order.paymentCapturedAtUtc
};

function request(suborderId: string): InventoryReservationRequest {
  return {
    tenantId: "merchant-tenant-" + suborderId,
    orderId: order.orderId,
    suborderId,
    merchantId: "merchant-" + suborderId,
    branchId: "branch-" + suborderId,
    idempotencyKey: "inventory-reservation:" + suborderId + ":v1",
    requestedAtUtc: order.paymentCapturedAtUtc,
    lines: [{ productVariantId: "variant-" + suborderId, sku: "SKU-" + suborderId, quantity: 1 }]
  };
}

function harness(unavailableSuborder?: string) {
  const calls: string[] = [];
  const publishedTasks: ScheduledFulfillmentTaskEnvelope[] = [];
  const paymentCaptureRecorder = {
    async recordPaymentCapture() {
      calls.push("payment_capture_evidence");
      return "inserted" as const;
    }
  };
  const inventoryPort: InventoryReservationPort = {
    async reserveExactVariants(value) {
      calls.push("reserve:" + value.suborderId);
      if (value.suborderId === unavailableSuborder) {
        return { outcome: "unavailable" as const, unavailableLines: [value.lines[0]!.productVariantId] };
      }
      return { outcome: "reserved" as const, reservationReference: "reservation:" + value.suborderId };
    }
  };
  const transactionRunner: ScheduledOrderTransactionRunner = {
    async run(work) {
      calls.push("begin_task_transaction");
      const result = await work({
        async saveConfirmedOrder() { calls.push("persist_payment_confirmation"); },
        async enqueueOutbox(record) {
          calls.push("enqueue:" + record.taskType);
          publishedTasks.push(record.payload);
          return "inserted";
        }
      });
      calls.push("commit_task_transaction");
      return result;
    }
  };
  return { calls, publishedTasks, paymentCaptureRecorder, inventoryPort, transactionRunner };
}

describe("paid scheduled checkout orchestration", () => {
  it("persists payment evidence, reserves each branch, then enqueues targeted tasks", async () => {
    const h = harness();
    const result: ScheduledCheckoutOrchestrationResult = await orchestratePaidScheduledCheckout({
      order, plan, inventoryRequests: [request("suborder-b"), request("suborder-a")],
      ...h, outboxIdForTask: (_task, index) => "outbox-" + index
    });
    expect(result.status).toBe("scheduled");
    expect(h.calls.slice(0, 3)).toEqual([
      "payment_capture_evidence", "reserve:suborder-a", "reserve:suborder-b"
    ]);
    expect(h.calls[3]).toBe("begin_task_transaction");
    expect(h.publishedTasks).toHaveLength(4);
    expect(new Set(h.publishedTasks.map(task => task.idempotencyKey)).size).toBe(4);
    expect(h.publishedTasks.every(task => task.target?.suborderId === "suborder-a" ||
      task.target?.suborderId === "suborder-b")).toBe(true);
    expect(h.publishedTasks.every(task => task.target?.merchantTenantId.startsWith("merchant-tenant-"))).toBe(true);
  });

  it("does not enqueue preparation or dispatch when any branch cannot reserve stock", async () => {
    const h = harness("suborder-b");
    const result = await orchestratePaidScheduledCheckout({
      order, plan, inventoryRequests: [request("suborder-a"), request("suborder-b")],
      ...h, outboxIdForTask: (_task, index) => "outbox-" + index
    });
    expect(result.status).toBe("inventory_unavailable");
    if (result.status !== "inventory_unavailable") throw new Error("expected inventory exception");
    expect(result.failedSuborderId).toBe("suborder-b");
    expect(result.reservationReferences).toEqual([
      { suborderId: "suborder-a", reservationReference: "reservation:suborder-a" }
    ]);
    expect(h.calls).toEqual([
      "payment_capture_evidence", "reserve:suborder-a", "reserve:suborder-b"
    ]);
    expect(h.publishedTasks).toHaveLength(0);
  });

  it("durably records a paid checkout recovery case when one merchant cannot reserve stock", async () => {
    const h = harness("suborder-b");
    const recorded: unknown[] = [];
    const result = await orchestratePaidScheduledCheckout({
      order, plan, inventoryRequests: [request("suborder-a"), request("suborder-b")],
      ...h,
      recoveryRecorder: { record: async input => {
        recorded.push(input);
        return { outcome: "recorded" as const, caseId: "recovery-1" };
      } },
      outboxIdForTask: (_task, index) => "outbox-recovery-" + index
    });
    expect(result.status).toBe("inventory_unavailable");
    if (result.status !== "inventory_unavailable") throw new Error("expected inventory exception");
    expect(result.recoveryCase).toEqual({ status: "recorded", caseId: "recovery-1" });
    expect(recorded[0]).toMatchObject({
      tenantId: order.tenantId, orderId: order.orderId,
      failureCode: "INVENTORY_UNAVAILABLE", failedSuborderId: "suborder-b",
      paymentReference: order.paymentReference,
      reservationReferences: [{ suborderId: "suborder-a", reservationReference: "reservation:suborder-a" }]
    });
    expect(h.publishedTasks).toHaveLength(0);
  });

  it("surfaces recovery persistence failure instead of hiding an unresolved paid order", async () => {
    const h = harness("suborder-b");
    const result = await orchestratePaidScheduledCheckout({
      order, plan, inventoryRequests: [request("suborder-a"), request("suborder-b")],
      ...h,
      recoveryRecorder: { record: async () => { throw new Error("database unavailable"); } },
      outboxIdForTask: (_task, index) => "outbox-recovery-failed-" + index
    });
    expect(result.status).toBe("inventory_unavailable");
    if (result.status !== "inventory_unavailable") throw new Error("expected inventory exception");
    expect(result.recoveryCase).toEqual({ status: "persistence_failed" });
  });

  it("rejects mixed-parent and duplicate-suborder requests before payment evidence", async () => {
    const h = harness();
    const invalid = { ...request("suborder-a"), orderId: "another-order" };
    const result = await orchestratePaidScheduledCheckout({
      order, plan, inventoryRequests: [invalid],
      ...h, outboxIdForTask: (_task, index) => "outbox-" + index
    });
    expect(result).toEqual({ status: "rejected", reason: "invalid_checkout_input" });
    expect(h.calls).toEqual([]);
  });

  it("uses a separately resolved schedule for each merchant suborder", async () => {
    const h = harness();
    const branchPlans = new Map([
      ["suborder-a", { ...plan, preparationReleaseAtUtc: "2026-11-08T12:00:00.000Z", courierDispatchAtUtc: "2026-11-08T12:30:00.000Z" }],
      ["suborder-b", { ...plan, preparationReleaseAtUtc: "2026-11-08T13:00:00.000Z", courierDispatchAtUtc: "2026-11-08T13:45:00.000Z" }]
    ]);
    const result = await orchestratePaidScheduledCheckout({
      order, plan, inventoryRequests: [request("suborder-a"), request("suborder-b")],
      planForSuborder: value => branchPlans.get(value.suborderId)!,
      ...h, outboxIdForTask: (_task, index) => "outbox-branch-plan-" + index
    });
    expect(result.status).toBe("scheduled");
    const a = h.publishedTasks.filter(task => task.target?.suborderId === "suborder-a");
    const b = h.publishedTasks.filter(task => task.target?.suborderId === "suborder-b");
    expect(a.map(task => task.executeAtUtc)).toEqual(["2026-11-08T12:00:00.000Z", "2026-11-08T12:30:00.000Z"]);
    expect(b.map(task => task.executeAtUtc)).toEqual(["2026-11-08T13:00:00.000Z", "2026-11-08T13:45:00.000Z"]);
  });

  it("rejects an invalid branch schedule before recording payment evidence", async () => {
    const h = harness();
    const result = await orchestratePaidScheduledCheckout({
      order, plan, inventoryRequests: [request("suborder-a")],
      planForSuborder: () => ({ ...plan, orderId: "another-order" }),
      ...h, outboxIdForTask: (_task, index) => "outbox-invalid-plan-" + index
    });
    expect(result).toEqual({ status: "rejected", reason: "invalid_checkout_input" });
    expect(h.calls).toEqual([]);
  });
});
