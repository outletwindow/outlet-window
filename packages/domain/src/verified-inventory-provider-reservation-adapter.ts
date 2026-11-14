import type {
  InventoryReservationPort, InventoryReservationPortResult, InventoryReservationRequest
} from "./inventory-reservation.js";

export interface InventoryProviderReservationCommand {
  providerIntegrationId: string;
  tenantId: string;
  merchantId: string;
  branchId: string;
  idempotencyKey: string;
  requestedAtUtc: string;
  lines: InventoryReservationRequest["lines"];
}

export type InventoryProviderReservationAcknowledgement =
  | {
      outcome: "reserved";
      tenantId: string;
      merchantId: string;
      branchId: string;
      idempotencyKey: string;
      reservationReference: string;
      expiresAtUtc: string;
      lines: InventoryReservationRequest["lines"];
    }
  | {
      outcome: "unavailable";
      tenantId: string;
      merchantId: string;
      branchId: string;
      idempotencyKey: string;
      unavailableLines: readonly string[];
    }
  | { outcome: "unsupported"; reason: "hard_reservation_not_supported" };

/**
 * Provider-specific clients implement this contract. They own authentication,
 * TLS/signature verification, credential resolution, branch/SKU mapping, and
 * provider API transport. Never implement this with an arbitrary user URL.
 */
export interface InventoryProviderReservationClient {
  reserveExactVariants(command: InventoryProviderReservationCommand): Promise<InventoryProviderReservationAcknowledgement>;
}

export class InventoryProviderTransientError extends Error {
  constructor() {
    super("INVENTORY_PROVIDER_TRANSIENT_FAILURE");
    this.name = "InventoryProviderTransientError";
  }
}

function validUtc(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && value.endsWith("Z") && new Date(parsed).toISOString() === value;
}

function sameLines(
  expected: InventoryReservationRequest["lines"],
  actual: InventoryReservationRequest["lines"]
): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const byVariant = new Map(actual.map(line => [line.productVariantId, line]));
  return expected.every(line => {
    const returned = byVariant.get(line.productVariantId);
    return returned?.sku === line.sku && returned.quantity === line.quantity;
  });
}

/**
 * Validates provider acknowledgements before they can be treated as a hard hold.
 * Any malformed or cross-scope acknowledgement throws, allowing the durable worker
 * to retry and eventually route the order to recovery instead of confirming it.
 */
export class VerifiedInventoryProviderReservationAdapter implements InventoryReservationPort {
  constructor(private readonly client: InventoryProviderReservationClient) {}

  async reserveExactVariants(request: InventoryReservationRequest): Promise<InventoryReservationPortResult> {
    if (!request.providerIntegrationId?.trim()) {
      return { outcome: "unsupported", reason: "hard_reservation_not_supported" };
    }
    const acknowledgement = await this.client.reserveExactVariants({
      providerIntegrationId: request.providerIntegrationId,
      tenantId: request.tenantId,
      merchantId: request.merchantId,
      branchId: request.branchId,
      idempotencyKey: request.idempotencyKey,
      requestedAtUtc: request.requestedAtUtc,
      lines: request.lines
    });

    if (acknowledgement.outcome === "unsupported") return acknowledgement;
    if (acknowledgement.tenantId !== request.tenantId ||
        acknowledgement.merchantId !== request.merchantId ||
        acknowledgement.branchId !== request.branchId ||
        acknowledgement.idempotencyKey !== request.idempotencyKey) {
      throw new Error("INVENTORY_PROVIDER_ACKNOWLEDGEMENT_SCOPE_MISMATCH");
    }

    if (acknowledgement.outcome === "unavailable") {
      const requestedVariants = new Set(request.lines.map(line => line.productVariantId));
      if (!Array.isArray(acknowledgement.unavailableLines) ||
          acknowledgement.unavailableLines.length === 0 ||
          acknowledgement.unavailableLines.some(id => !requestedVariants.has(id)) ||
          new Set(acknowledgement.unavailableLines).size !== acknowledgement.unavailableLines.length) {
        throw new Error("INVENTORY_PROVIDER_ACKNOWLEDGEMENT_LINES_MISMATCH");
      }
      return { outcome: "unavailable", unavailableLines: [...acknowledgement.unavailableLines] };
    }

    if (typeof acknowledgement.reservationReference !== "string" ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(acknowledgement.reservationReference) ||
        !validUtc(acknowledgement.expiresAtUtc) ||
        Date.parse(acknowledgement.expiresAtUtc) <= Date.parse(request.requestedAtUtc) ||
        !sameLines(request.lines, acknowledgement.lines)) {
      throw new Error("INVENTORY_PROVIDER_ACKNOWLEDGEMENT_INVALID");
    }

    return {
      outcome: "reserved",
      reservationReference: acknowledgement.reservationReference,
      expiresAtUtc: acknowledgement.expiresAtUtc
    };
  }
}
