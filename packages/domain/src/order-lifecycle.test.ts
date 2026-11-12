import { describe, expect, it } from "vitest";
import { aggregateParentOrderStatus, transitionOrder, type OrderLifecycle } from "./order-lifecycle.js";

const base: OrderLifecycle = {
  orderId: "order-1", merchantId: "merchant-1", branchId: "branch-1",
  status: "awaiting_payment", version: 4, updatedAt: "2026-11-07T10:00:00.000Z"
};
const context = {
  actorId: "principal-1", actorRole: "merchant_owner",
  occurredAt: "2026-11-07T11:00:00.000Z", expectedVersion: 4
};

describe("order lifecycle", () => {
  it("requires both payment authorization and inventory reservation before confirmation", () => {
    expect(transitionOrder(base, "confirmed", { ...context, paymentAuthorized: true })).toEqual({
      ok: false, reason: "inventory_not_reserved"
    });
    expect(transitionOrder(base, "confirmed", { ...context, inventoryReserved: true })).toEqual({
      ok: false, reason: "payment_not_authorized"
    });
    const result = transitionOrder(base, "confirmed", { ...context, paymentAuthorized: true, inventoryReserved: true });
    expect(result.ok && result.order).toMatchObject({ status: "confirmed", version: 5 });
  });

  it("rejects stale writes and invalid state jumps", () => {
    expect(transitionOrder(base, "confirmed", { ...context, expectedVersion: 3, paymentAuthorized: true, inventoryReserved: true })).toEqual({ ok: false, reason: "version_conflict" });
    expect(transitionOrder(base, "delivered", { ...context, deliveryProofVerified: true })).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("requires verified delivery proof and provider-confirmed refunds", () => {
    const outbound = { ...base, status: "out_for_delivery" as const };
    expect(transitionOrder(outbound, "delivered", { ...context, deliveryProofVerified: false })).toEqual({ ok: false, reason: "delivery_proof_missing" });
    const refund = { ...base, status: "refund_pending" as const };
    expect(transitionOrder(refund, "refunded", context)).toEqual({ ok: false, reason: "refund_not_confirmed" });
    expect(transitionOrder(refund, "refunded", { ...context, refundConfirmed: true }).ok).toBe(true);
  });

  it("requires reasons for exception and cancellation transitions", () => {
    const confirmed = { ...base, status: "confirmed" as const };
    expect(transitionOrder(confirmed, "on_hold", context)).toEqual({ ok: false, reason: "missing_reason" });
  });

  it("aggregates multi-merchant suborders without erasing their individual states", () => {
    expect(aggregateParentOrderStatus(["completed", "preparing"])).toBe("preparing");
    expect(aggregateParentOrderStatus(["completed", "delivered"])).toBe("delivered");
    expect(aggregateParentOrderStatus(["completed", "disputed"])).toBe("disputed");
    expect(aggregateParentOrderStatus(["cancelled", "refunded"])).toBe("cancelled");
    expect(() => aggregateParentOrderStatus([])).toThrow();
  });
});
