import { describe, expect, it, vi } from "vitest";
import type { InventoryReservationPort, InventoryReservationRequest } from "./inventory-reservation.js";
import { PostgresMerchantInventoryReservationRouter } from "./postgres-merchant-inventory-reservation-router.js";
import type { PostgresQueryable } from "./postgres-iam-store.js";

const request: InventoryReservationRequest = {
  tenantId: "merchant-tenant-1", orderId: "order-1", suborderId: "suborder-1",
  merchantId: "merchant-1", branchId: "branch-1",
  idempotencyKey: "paid-checkout:order-1:suborder-1",
  requestedAtUtc: "2026-11-14T12:00:00.000Z",
  lines: [{ productVariantId: "variant-1", sku: "SKU-1", quantity: 2 }]
};

function database(rows: Array<{ id: string; provider_key: string }>) {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
    rows, rowCount: rows.length
  }));
  return { client: { query } as unknown as PostgresQueryable, query };
}

describe("PostgresMerchantInventoryReservationRouter", () => {
  it("routes to the single connected provider with a hard-reservation branch grant", async () => {
    const db = database([{ id: "pos-1", provider_key: "pos-acme" }]);
    const reserveExactVariants = vi.fn(async (input: InventoryReservationRequest) => ({
      outcome: "reserved" as const, reservationReference: "external-hold-1"
    }));
    const adapter: InventoryReservationPort = { reserveExactVariants };
    const router = new PostgresMerchantInventoryReservationRouter(db.client, new Map([["pos-acme", adapter]]));
    await expect(router.reserveExactVariants(request)).resolves.toEqual({
      outcome: "reserved", reservationReference: "external-hold-1"
    });
    expect(reserveExactVariants).toHaveBeenCalledWith(request);
    expect(db.query.mock.calls[0]?.[1]).toEqual(["merchant-tenant-1", "merchant-1", "branch-1"]);
    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("i.capabilities @> '[\"inventory.hard_reservation\"]'::jsonb");
    expect(sql).toContain("i.status = 'connected'");
    expect(sql).toContain("s.active = true");
    expect(sql).toContain("m.status = 'active'");
    expect(sql).toContain("b.status = 'active'");
  });

  it("fails closed when no provider has an exact branch grant", async () => {
    const db = database([]);
    const reserveExactVariants = vi.fn();
    const router = new PostgresMerchantInventoryReservationRouter(db.client, new Map([
      ["pos-acme", { reserveExactVariants }]
    ]));
    await expect(router.reserveExactVariants(request)).resolves.toEqual({
      outcome: "unsupported", reason: "merchant_integration_missing"
    });
    expect(reserveExactVariants).not.toHaveBeenCalled();
  });

  it("fails closed when provider identity is ambiguous", async () => {
    const db = database([
      { id: "pos-1", provider_key: "pos-acme" },
      { id: "erp-1", provider_key: "erp-acme" }
    ]);
    const reserveExactVariants = vi.fn();
    const router = new PostgresMerchantInventoryReservationRouter(db.client, new Map([
      ["pos-acme", { reserveExactVariants }]
    ]));
    await expect(router.reserveExactVariants(request)).resolves.toEqual({
      outcome: "unsupported", reason: "hard_reservation_not_supported"
    });
    expect(reserveExactVariants).not.toHaveBeenCalled();
  });

  it("fails closed when an integration is eligible but no adapter is configured", async () => {
    const db = database([{ id: "pos-1", provider_key: "unknown-pos" }]);
    const router = new PostgresMerchantInventoryReservationRouter(db.client, new Map());
    await expect(router.reserveExactVariants(request)).resolves.toEqual({
      outcome: "unsupported", reason: "hard_reservation_not_supported"
    });
  });
});
