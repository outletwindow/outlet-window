import type {
  InventoryReservationPort, InventoryReservationPortResult, InventoryReservationRequest
} from "./inventory-reservation.js";
import {
  VerifiedInventoryProviderReservationAdapter,
  type InventoryProviderReservationClient
} from "./verified-inventory-provider-reservation-adapter.js";
import type { ExternalInventoryReservationEvidenceStore } from "./postgres-external-inventory-reservation-evidence-store.js";

/**
 * Production composition: verify the external receipt, then durably mirror it
 * into the local reservation ledger before checkout may confirm the suborder.
 */
export class LedgerBackedInventoryProviderReservationAdapter implements InventoryReservationPort {
  private readonly verified: VerifiedInventoryProviderReservationAdapter;

  constructor(
    client: InventoryProviderReservationClient,
    private readonly ledger: ExternalInventoryReservationEvidenceStore,
    private readonly providerKey: string
  ) {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(providerKey)) {
      throw new Error("inventory_provider_key_invalid");
    }
    this.verified = new VerifiedInventoryProviderReservationAdapter(client);
  }

  async reserveExactVariants(request: InventoryReservationRequest): Promise<InventoryReservationPortResult> {
    const result = await this.verified.reserveExactVariants(request);
    if (result.outcome !== "reserved") return result;
    if (!result.expiresAtUtc) throw new Error("INVENTORY_PROVIDER_RESERVATION_EXPIRY_REQUIRED");
    const recorded = await this.ledger.record({
      request, providerKey: this.providerKey,
      providerReservationReference: result.reservationReference,
      expiresAtUtc: result.expiresAtUtc
    });
    return {
      outcome: "reserved",
      reservationReference: recorded.reservationId,
      expiresAtUtc: result.expiresAtUtc
    };
  }
}
