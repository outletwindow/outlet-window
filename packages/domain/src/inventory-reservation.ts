export interface InventoryReservationLine {
  productVariantId: string;
  sku: string;
  quantity: number;
}

export interface InventoryReservationRequest {
  tenantId: string;
  orderId: string;
  suborderId: string;
  merchantId: string;
  branchId: string;
  idempotencyKey: string;
  requestedAtUtc: string;
  expiresAtUtc?: string;
  lines: readonly InventoryReservationLine[];
}

export type InventoryReservationPortResult =
  | { outcome: "reserved"; reservationReference: string; expiresAtUtc?: string }
  | { outcome: "unavailable"; unavailableLines: readonly string[] }
  | { outcome: "unsupported"; reason: "merchant_integration_missing" | "hard_reservation_not_supported" };

export interface InventoryReservationPort {
  /** Must reserve every requested variant atomically, or reserve none; idempotency is mandatory. */
  reserveExactVariants(request: InventoryReservationRequest): Promise<InventoryReservationPortResult>;
}

export type InventoryReservationResult =
  | { state: "reserved"; reservationReference: string; expiresAtUtc?: string }
  | { state: "unavailable"; unavailableLines: readonly string[] }
  | { state: "unguaranteed"; reason: "merchant_integration_missing" | "hard_reservation_not_supported" };

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function validateRequest(request: InventoryReservationRequest): void {
  for (const [field, value] of Object.entries({
    tenantId: request.tenantId, orderId: request.orderId, suborderId: request.suborderId, merchantId: request.merchantId,
    branchId: request.branchId, idempotencyKey: request.idempotencyKey
  })) {
    if (!value.trim()) throw new Error("inventory_reservation_" + field + "_required");
  }
  if (!validTimestamp(request.requestedAtUtc) ||
      (request.expiresAtUtc !== undefined && (!validTimestamp(request.expiresAtUtc) ||
        Date.parse(request.expiresAtUtc) <= Date.parse(request.requestedAtUtc)))) {
    throw new Error("inventory_reservation_invalid_timestamp");
  }
  if (!Array.isArray(request.lines) || request.lines.length === 0) {
    throw new Error("inventory_reservation_lines_required");
  }
  const variants = new Set<string>();
  for (const line of request.lines) {
    if (!line.productVariantId.trim() || !line.sku.trim() ||
        !Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw new Error("inventory_reservation_invalid_line");
    }
    if (variants.has(line.productVariantId)) throw new Error("inventory_reservation_duplicate_variant");
    variants.add(line.productVariantId);
  }
}

/**
 * Checkout-side reservation boundary. Call only after payment is confirmed.
 * A merchant adapter must atomically reserve exact variants at the selected branch.
 * Missing hard-reservation support is reported as unguaranteed, never as reserved.
 */
export async function reserveInventoryForPaidOrder(input: {
  paymentCaptured: boolean;
  request: InventoryReservationRequest;
  port: InventoryReservationPort;
}): Promise<InventoryReservationResult> {
  if (input.paymentCaptured !== true) throw new Error("inventory_reservation_payment_not_confirmed");
  validateRequest(input.request);
  const result = await input.port.reserveExactVariants(input.request);
  if (result.outcome === "reserved") {
    if (!result.reservationReference.trim()) throw new Error("inventory_reservation_reference_missing");
    if (result.expiresAtUtc !== undefined && !validTimestamp(result.expiresAtUtc)) {
      throw new Error("inventory_reservation_invalid_expiry");
    }
    return {
      state: "reserved",
      reservationReference: result.reservationReference,
      ...(result.expiresAtUtc === undefined ? {} : { expiresAtUtc: new Date(result.expiresAtUtc).toISOString() })
    };
  }
  if (result.outcome === "unavailable") {
    return { state: "unavailable", unavailableLines: [...result.unavailableLines] };
  }
  return { state: "unguaranteed", reason: result.reason };
}

/** Preparation may be released only after the exact requested inventory is reserved. */
export function canReleasePreparation(input: {
  inventoryState: "not_requested" | "reserved" | "unavailable" | "unguaranteed";
  executeAtUtc: string;
  nowUtc: string;
}): boolean {
  const executeAt = Date.parse(input.executeAtUtc);
  const now = Date.parse(input.nowUtc);
  return input.inventoryState === "reserved" &&
    Number.isFinite(executeAt) && Number.isFinite(now) && now >= executeAt;
}
