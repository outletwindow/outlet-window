export const PAID_ORDER_EDIT_WINDOW_SECONDS = 5;
export const PAID_ORDER_EDIT_WINDOW_MS = PAID_ORDER_EDIT_WINDOW_SECONDS * 1000;

export type PaidOrderEditStatus =
  | "confirmed" | "merchant_acceptance_pending" | "preparing" | "ready_for_pickup"
  | "pickup_in_progress" | "in_transit" | "out_for_delivery" | "delivered"
  | "completed" | "cancelled" | "refunded";

export type PaidOrderEditDecision =
  | { allowed: true; editUntilUtc: string; remainingMilliseconds: number }
  | { allowed: false; reason: "invalid_payment_time" | "invalid_current_time" | "edit_window_expired" | "fulfillment_already_started" };

const fulfillmentStarted = new Set<PaidOrderEditStatus>([
  "preparing", "ready_for_pickup", "pickup_in_progress", "in_transit",
  "out_for_delivery", "delivered", "completed", "cancelled", "refunded"
]);

/** Five-second customer edit window measured from provider-confirmed payment capture. */
export function evaluatePaidOrderEditWindow(input: {
  paymentCapturedAtUtc: string;
  nowUtc: string;
  status: PaidOrderEditStatus;
  fulfillmentTaskDispatched?: boolean;
}): PaidOrderEditDecision {
  const captured = Date.parse(input.paymentCapturedAtUtc);
  const now = Date.parse(input.nowUtc);
  if (!Number.isFinite(captured)) return { allowed: false, reason: "invalid_payment_time" };
  if (!Number.isFinite(now)) return { allowed: false, reason: "invalid_current_time" };
  const editUntil = captured + PAID_ORDER_EDIT_WINDOW_MS;
  if (fulfillmentStarted.has(input.status) || input.fulfillmentTaskDispatched === true) {
    return { allowed: false, reason: "fulfillment_already_started" };
  }
  if (now < captured || now >= editUntil) return { allowed: false, reason: "edit_window_expired" };
  return {
    allowed: true,
    editUntilUtc: new Date(editUntil).toISOString(),
    remainingMilliseconds: Math.max(0, editUntil - now)
  };
}

export interface DeliveryCoordinate {
  latitude: number;
  longitude: number;
}

export interface DeliveryServiceArea {
  id: string;
  center: DeliveryCoordinate;
  radiusMeters: number;
}

export interface RepricedDeliveryQuote {
  branchId: string;
  deliveryFeeMinor: number;
  totalMinor: number;
  currency: string;
  estimatedDeliveryAtUtc: string;
  quoteReference: string;
  expiresAtUtc: string;
}

export type DeliveryDestinationChangeResult =
  | { allowed: true; destination: DeliveryCoordinate; quote: RepricedDeliveryQuote; changedBranch: boolean }
  | { allowed: false; reason: "invalid_destination" | "invalid_service_area" | "outside_service_area" | "invalid_quote" };

function validCoordinate(point: DeliveryCoordinate): boolean {
  return Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90 &&
    Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180;
}

export function distanceBetweenCoordinatesMeters(a: DeliveryCoordinate, b: DeliveryCoordinate): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const latitudeA = radians(a.latitude);
  const latitudeB = radians(b.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

/**
 * Applies the agreed circular service-area boundary before accepting a destination.
 * The quote must be produced by trusted server-side pricing/branch selection, never by the client.
 */
export function validateDeliveryDestinationChange(input: {
  destination: DeliveryCoordinate;
  serviceArea: DeliveryServiceArea;
  currentBranchId: string;
  quote: RepricedDeliveryQuote;
  nowUtc: string;
}): DeliveryDestinationChangeResult {
  if (!validCoordinate(input.destination)) return { allowed: false, reason: "invalid_destination" };
  if (!input.serviceArea.id.trim() || !validCoordinate(input.serviceArea.center) ||
      !Number.isFinite(input.serviceArea.radiusMeters) || input.serviceArea.radiusMeters <= 0) {
    return { allowed: false, reason: "invalid_service_area" };
  }
  if (distanceBetweenCoordinatesMeters(input.serviceArea.center, input.destination) >
      input.serviceArea.radiusMeters) {
    return { allowed: false, reason: "outside_service_area" };
  }
  const quote = input.quote;
  if (!quote.branchId.trim() || !quote.quoteReference.trim() ||
      !Number.isSafeInteger(quote.deliveryFeeMinor) || quote.deliveryFeeMinor < 0 ||
      !Number.isSafeInteger(quote.totalMinor) || quote.totalMinor < 0 ||
      !/^[A-Z]{3}$/.test(quote.currency) ||
      !Number.isFinite(Date.parse(quote.estimatedDeliveryAtUtc)) ||
      !Number.isFinite(Date.parse(quote.expiresAtUtc)) ||
      !Number.isFinite(Date.parse(input.nowUtc)) ||
      Date.parse(quote.expiresAtUtc) <= Date.parse(input.nowUtc)) {
    return { allowed: false, reason: "invalid_quote" };
  }
  return {
    allowed: true,
    destination: { ...input.destination },
    quote,
    changedBranch: quote.branchId !== input.currentBranchId
  };
}
