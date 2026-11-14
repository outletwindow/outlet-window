import { describe, expect, it, vi } from "vitest";
import type { InventoryReservationRequest } from "./inventory-reservation.js";
import {
  VerifiedInventoryProviderReservationAdapter,
  type InventoryProviderReservationAcknowledgement,
  type InventoryProviderReservationClient
} from "./verified-inventory-provider-reservation-adapter.js";

const request: InventoryReservationRequest = {
  tenantId: "tenant-1", orderId: "order-1", suborderId: "suborder-1",
  merchantId: "merchant-1", branchId: "branch-1",
  providerIntegrationId: "integration-1",
  idempotencyKey: "paid-checkout:tenant-1:order-1:suborder-1",
  requestedAtUtc: "2026-11-14T12:00:00.000Z",
  lines: [
    { productVariantId: "variant-1", sku: "SKU-1", quantity: 2 },
    { productVariantId: "variant-2", sku: "SKU-2", quantity: 1 }
  ]
};

const reserved: InventoryProviderReservationAcknowledgement = {
  outcome: "reserved", tenantId: request.tenantId, merchantId: request.merchantId,
  branchId: request.branchId, idempotencyKey: request.idempotencyKey,
  reservationReference: "hold-123", expiresAtUtc: "2026-11-14T12:15:00.000Z",
  lines: request.lines
};

function adapterFor(acknowledgement: InventoryProviderReservationAcknowledgement) {
  const reserveExactVariants = vi.fn(async () => acknowledgement);
  const client: InventoryProviderReservationClient = { reserveExactVariants };
  return { adapter: new VerifiedInventoryProviderReservationAdapter(client), reserveExactVariants };
}

describe("VerifiedInventoryProviderReservationAdapter", () => {
  it("passes the exact provider integration, branch, idempotency key, and variant lines", async () => {
    const { adapter, reserveExactVariants } = adapterFor(reserved);
    await expect(adapter.reserveExactVariants(request)).resolves.toEqual({
      outcome: "reserved", reservationReference: "hold-123",
      expiresAtUtc: "2026-11-14T12:15:00.000Z"
    });
    expect(reserveExactVariants).toHaveBeenCalledWith({
      providerIntegrationId: "integration-1", tenantId: "tenant-1",
      merchantId: "merchant-1", branchId: "branch-1",
      idempotencyKey: request.idempotencyKey,
      requestedAtUtc: request.requestedAtUtc, lines: request.lines
    });
  });

  it("fails closed if the trusted router did not bind an integration id", async () => {
    const { adapter, reserveExactVariants } = adapterFor(reserved);
    const { providerIntegrationId: _providerIntegrationId, ...unbound } = request;
    await expect(adapter.reserveExactVariants(unbound)).resolves.toEqual({
      outcome: "unsupported", reason: "hard_reservation_not_supported"
    });
    expect(reserveExactVariants).not.toHaveBeenCalled();
  });

  it("rejects acknowledgements for a different tenant, merchant, or branch", async () => {
    for (const patch of [
      { tenantId: "other-tenant" }, { merchantId: "other-merchant" }, { branchId: "other-branch" }
    ]) {
      const { adapter } = adapterFor({ ...reserved, ...patch });
      await expect(adapter.reserveExactVariants(request)).rejects.toThrow("INVENTORY_PROVIDER_ACKNOWLEDGEMENT_SCOPE_MISMATCH");
    }
  });

  it("rejects an acknowledgement with a different idempotency key", async () => {
    const { adapter } = adapterFor({ ...reserved, idempotencyKey: "different-key" });
    await expect(adapter.reserveExactVariants(request)).rejects.toThrow("INVENTORY_PROVIDER_ACKNOWLEDGEMENT_SCOPE_MISMATCH");
  });

  it("rejects partial, altered, or extra variant acknowledgements", async () => {
    const altered = { ...reserved, lines: [{ ...request.lines[0]!, quantity: 1 }] };
    const { adapter } = adapterFor(altered);
    await expect(adapter.reserveExactVariants(request)).rejects.toThrow("INVENTORY_PROVIDER_ACKNOWLEDGEMENT_INVALID");
  });

  it("rejects duplicate or substituted variant lines in a provider acknowledgement", async () => {
    const { adapter } = adapterFor({
      ...reserved,
      lines: [request.lines[0]!, request.lines[0]!]
    });
    await expect(adapter.reserveExactVariants(request)).rejects.toThrow("INVENTORY_PROVIDER_ACKNOWLEDGEMENT_INVALID");
  });

  it("rejects expired, malformed, or unsafe reservation references", async () => {
    for (const patch of [
      { expiresAtUtc: "2026-11-14T11:59:00.000Z" },
      { expiresAtUtc: "tomorrow" },
      { reservationReference: "hold\n123" }
    ]) {
      const { adapter } = adapterFor({ ...reserved, ...patch });
      await expect(adapter.reserveExactVariants(request)).rejects.toThrow("INVENTORY_PROVIDER_ACKNOWLEDGEMENT_INVALID");
    }
  });

  it("returns unavailable only for exact requested variants", async () => {
    const { adapter } = adapterFor({
      outcome: "unavailable", tenantId: request.tenantId, merchantId: request.merchantId,
      branchId: request.branchId, idempotencyKey: request.idempotencyKey,
      unavailableLines: ["variant-2"]
    });
    await expect(adapter.reserveExactVariants(request)).resolves.toEqual({
      outcome: "unavailable", unavailableLines: ["variant-2"]
    });
  });

  it("rejects provider-reported unavailable variants outside the request", async () => {
    const { adapter } = adapterFor({
      outcome: "unavailable", tenantId: request.tenantId, merchantId: request.merchantId,
      branchId: request.branchId, idempotencyKey: request.idempotencyKey,
      unavailableLines: ["not-requested"]
    });
    await expect(adapter.reserveExactVariants(request)).rejects.toThrow("INVENTORY_PROVIDER_ACKNOWLEDGEMENT_LINES_MISMATCH");
  });

  it("preserves explicit provider unsupported responses", async () => {
    const { adapter } = adapterFor({ outcome: "unsupported", reason: "hard_reservation_not_supported" });
    await expect(adapter.reserveExactVariants(request)).resolves.toEqual({
      outcome: "unsupported", reason: "hard_reservation_not_supported"
    });
  });
});
