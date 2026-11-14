import { describe, expect, it, vi } from "vitest";
import type { InventoryReservationRequest } from "./inventory-reservation.js";
import {
  LedgerBackedInventoryProviderReservationAdapter
} from "./ledger-backed-inventory-provider-reservation-adapter.js";
import type { ExternalInventoryReservationEvidenceStore } from "./postgres-external-inventory-reservation-evidence-store.js";
import type { InventoryProviderReservationClient } from "./verified-inventory-provider-reservation-adapter.js";

const request: InventoryReservationRequest = {
  tenantId:"tenant-1",orderId:"order-1",suborderId:"suborder-1",
  merchantId:"merchant-1",branchId:"branch-1",providerIntegrationId:"integration-1",
  idempotencyKey:"paid-checkout:tenant-1:order-1:suborder-1",
  requestedAtUtc:"2026-11-14T12:00:00.000Z",
  lines:[{productVariantId:"variant-1",sku:"SKU-1",quantity:2}]
};

describe("LedgerBackedInventoryProviderReservationAdapter", () => {
  it("persists verified external reservation evidence before returning a local ledger id", async () => {
    const client: InventoryProviderReservationClient = {
      reserveExactVariants: vi.fn().mockResolvedValue({
        outcome:"reserved",tenantId:"tenant-1",merchantId:"merchant-1",branchId:"branch-1",
        idempotencyKey:request.idempotencyKey,reservationReference:"external-hold-1",
        expiresAtUtc:"2026-11-14T12:15:00.000Z",lines:request.lines
      })
    };
    const record=vi.fn().mockResolvedValue({reservationId:"local-reservation-1"});
    const ledger:ExternalInventoryReservationEvidenceStore={record};
    const adapter=new LedgerBackedInventoryProviderReservationAdapter(client,ledger,"pos-acme");
    await expect(adapter.reserveExactVariants(request)).resolves.toEqual({
      outcome:"reserved",reservationReference:"local-reservation-1",
      expiresAtUtc:"2026-11-14T12:15:00.000Z"
    });
    expect(record).toHaveBeenCalledWith({
      request,providerKey:"pos-acme",providerReservationReference:"external-hold-1",
      expiresAtUtc:"2026-11-14T12:15:00.000Z"
    });
  });

  it("does not persist when provider says unavailable", async () => {
    const client:InventoryProviderReservationClient={
      reserveExactVariants:vi.fn().mockResolvedValue({
        outcome:"unavailable",tenantId:"tenant-1",merchantId:"merchant-1",branchId:"branch-1",
        idempotencyKey:request.idempotencyKey,unavailableLines:["variant-1"]
      })
    };
    const record=vi.fn();
    const adapter=new LedgerBackedInventoryProviderReservationAdapter(
      client,{record} as unknown as ExternalInventoryReservationEvidenceStore,"pos-acme"
    );
    await expect(adapter.reserveExactVariants(request)).resolves.toEqual({
      outcome:"unavailable",unavailableLines:["variant-1"]
    });
    expect(record).not.toHaveBeenCalled();
  });

  it("does not return a reservation when ledger persistence fails", async () => {
    const client:InventoryProviderReservationClient={
      reserveExactVariants:vi.fn().mockResolvedValue({
        outcome:"reserved",tenantId:"tenant-1",merchantId:"merchant-1",branchId:"branch-1",
        idempotencyKey:request.idempotencyKey,reservationReference:"external-hold-1",
        expiresAtUtc:"2026-11-14T12:15:00.000Z",lines:request.lines
      })
    };
    const record=vi.fn().mockRejectedValue(new Error("database_unavailable"));
    const adapter=new LedgerBackedInventoryProviderReservationAdapter(
      client,{record} as unknown as ExternalInventoryReservationEvidenceStore,"pos-acme"
    );
    await expect(adapter.reserveExactVariants(request)).rejects.toThrow("database_unavailable");
  });
});
