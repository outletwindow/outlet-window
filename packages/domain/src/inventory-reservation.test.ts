import { describe, expect, it, vi } from "vitest";
import { canReleasePreparation, reserveInventoryForPaidOrder } from "./inventory-reservation.js";

const request = {
  tenantId: "merchant-tenant-1",
  orderId: "order-1",
  suborderId: "suborder-1",
  merchantId: "merchant-1",
  branchId: "branch-1",
  idempotencyKey: "inventory-reservation:order-1:v1",
  requestedAtUtc: "2026-11-08T09:00:00.000Z",
  lines: [{ productVariantId: "variant-black-m", sku: "TSHIRT-BLK-M", quantity: 2 }]
};

describe("inventory reservation boundary", () => {
  it("never calls the inventory adapter before payment confirmation", async () => {
    const reserveExactVariants = vi.fn();
    await expect(reserveInventoryForPaidOrder({
      paymentCaptured: false, request, port: { reserveExactVariants }
    })).rejects.toThrow("inventory_reservation_payment_not_confirmed");
    expect(reserveExactVariants).not.toHaveBeenCalled();
  });

  it("reports reserved only when the branch adapter confirms an atomic reservation", async () => {
    const result = await reserveInventoryForPaidOrder({
      paymentCaptured: true,
      request,
      port: { reserveExactVariants: vi.fn().mockResolvedValue({
        outcome: "reserved", reservationReference: "merchant-reservation-123",
        expiresAtUtc: "2026-11-08T10:00:00.000Z"
      }) }
    });
    expect(result).toEqual({
      state: "reserved", reservationReference: "merchant-reservation-123",
      expiresAtUtc: "2026-11-08T10:00:00.000Z"
    });
  });

  it("does not turn unavailable or unsupported merchant stock into a reservation", async () => {
    const unavailable = await reserveInventoryForPaidOrder({
      paymentCaptured: true, request,
      port: { reserveExactVariants: vi.fn().mockResolvedValue({
        outcome: "unavailable", unavailableLines: ["variant-black-m"]
      }) }
    });
    expect(unavailable).toEqual({ state: "unavailable", unavailableLines: ["variant-black-m"] });

    const unsupported = await reserveInventoryForPaidOrder({
      paymentCaptured: true, request,
      port: { reserveExactVariants: vi.fn().mockResolvedValue({
        outcome: "unsupported", reason: "hard_reservation_not_supported"
      }) }
    });
    expect(unsupported).toEqual({
      state: "unguaranteed", reason: "hard_reservation_not_supported"
    });
  });

  it("rejects duplicate variants and invalid quantities before adapter access", async () => {
    const reserveExactVariants = vi.fn();
    await expect(reserveInventoryForPaidOrder({
      paymentCaptured: true,
      request: { ...request, lines: [...request.lines, ...request.lines] },
      port: { reserveExactVariants }
    })).rejects.toThrow("inventory_reservation_duplicate_variant");
    expect(reserveExactVariants).not.toHaveBeenCalled();
  });

  it("releases preparation only after confirmed reservation and due UTC time", () => {
    const common = {
      executeAtUtc: "2026-11-08T10:00:00.000Z",
      nowUtc: "2026-11-08T10:00:00.000Z"
    };
    expect(canReleasePreparation({ ...common, inventoryState: "reserved" })).toBe(true);
    expect(canReleasePreparation({ ...common, inventoryState: "unavailable" })).toBe(false);
    expect(canReleasePreparation({
      ...common, inventoryState: "reserved", nowUtc: "2026-11-08T09:59:59.000Z"
    })).toBe(false);
  });
});
