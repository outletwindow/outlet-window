export const SCHEDULED_FULFILLMENT_TYPES = [
  "home_delivery",
  "store_pickup",
  "personal_shopper_pickup"
] as const;
export type ScheduledFulfillmentType = (typeof SCHEDULED_FULFILLMENT_TYPES)[number];

export const SCHEDULED_ORDER_STATUSES = [
  "awaiting_payment",
  "payment_authorized",
  "confirmed",
  "inventory_reserved",
  "preparation_scheduled",
  "preparation_released",
  "preparing",
  "ready",
  "handover",
  "completed",
  "cancelled",
  "exception"
] as const;
export type ScheduledOrderStatus = (typeof SCHEDULED_ORDER_STATUSES)[number];

export interface FulfillmentEstimate {
  /** Estimated active preparation time, in whole minutes. */
  preparationMinutes: number;
  /** Additional operational buffer, in whole minutes. */
  bufferMinutes: number;
  /** Estimated final-mile travel time for home delivery; zero for collection. */
  travelMinutes: number;
}

export interface ScheduledOrderPlan {
  orderId: string;
  fulfillmentType: ScheduledFulfillmentType;
  /** Customer-selected local ISO timestamp with explicit UTC offset, e.g. 2026-11-08T18:00:00+03:00. */
  scheduledFor: string;
  /** UTC instant derived by the server from scheduledFor. */
  scheduledForUtc: string;
  /** Payment is collected/authorized at confirmation, according to the configured payment policy. */
  paymentDueAt: string;
  /** Branch reservation should be requested immediately after successful payment and confirmation. */
  inventoryReservationDueAt: string;
  /** Preparation task is released at scheduledFor minus preparationMinutes and bufferMinutes. */
  preparationReleaseAtUtc: string;
  /** Courier dispatch may be released at this instant; for home delivery this allows travel time. */
  courierDispatchAtUtc?: string;
  estimate: FulfillmentEstimate;
  createdAt: string;
}

export interface FulfillmentSlot {
  id: string;
  fulfillmentType: ScheduledFulfillmentType;
  startsAtUtc: string;
  endsAtUtc: string;
  capacity: number;
  reservedCount: number;
}

export interface AlternativeFulfillmentOption {
  id: string;
  label: string;
  scheduledForUtc: string;
  priceDeltaMinor: number;
  currency: string;
  availabilityConfirmed: boolean;
}

export interface ScheduledOrderDecision {
  accepted: boolean;
  reason?: "slot_unavailable" | "inventory_unavailable" | "merchant_unavailable" | "invalid_schedule";
  alternatives: readonly AlternativeFulfillmentOption[];
}

export const MAX_SCHEDULE_HORIZON_DAYS = 90;

function isValidOffsetDateTime(value: string): boolean {
  // Require a timezone marker; a local timestamp without offset is ambiguous across markets/DST.
  if (!/(Z|[+-](?:0[0-9]|1[0-4]):[0-5][0-9])$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

export function isFulfillmentEstimateValid(estimate: FulfillmentEstimate): boolean {
  return [estimate.preparationMinutes, estimate.bufferMinutes, estimate.travelMinutes]
    .every((value) => Number.isInteger(value) && value >= 0 && value <= 24 * 60);
}

/**
 * Build a deterministic schedule. The caller must first confirm the slot, branch capacity,
 * merchant acceptance and payment result. This helper does not charge, reserve inventory,
 * enqueue work or dispatch a courier.
 */
export function createScheduledOrderPlan(input: {
  orderId: string;
  fulfillmentType: ScheduledFulfillmentType;
  scheduledFor: string;
  now: string;
  estimate: FulfillmentEstimate;
}): ScheduledOrderPlan | null {
  if (!input.orderId.trim() || !isValidOffsetDateTime(input.scheduledFor) ||
      !isValidOffsetDateTime(input.now) || !isFulfillmentEstimateValid(input.estimate)) return null;

  const scheduledAt = Date.parse(input.scheduledFor);
  const nowAt = Date.parse(input.now);
  const horizon = MAX_SCHEDULE_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  if (scheduledAt <= nowAt || scheduledAt - nowAt > horizon) return null;
  if (input.fulfillmentType !== "home_delivery" && input.estimate.travelMinutes !== 0) return null;

  const dispatchAt = input.fulfillmentType === "home_delivery"
    ? scheduledAt - input.estimate.travelMinutes * 60_000
    : undefined;
  const releaseAt = (dispatchAt ?? scheduledAt) -
    (input.estimate.preparationMinutes + input.estimate.bufferMinutes) * 60_000;

  return {
    orderId: input.orderId,
    fulfillmentType: input.fulfillmentType,
    scheduledFor: input.scheduledFor,
    scheduledForUtc: new Date(scheduledAt).toISOString(),
    paymentDueAt: new Date(nowAt).toISOString(),
    inventoryReservationDueAt: new Date(nowAt).toISOString(),
    preparationReleaseAtUtc: new Date(Math.max(nowAt, releaseAt)).toISOString(),
    ...(dispatchAt === undefined ? {} : { courierDispatchAtUtc: new Date(Math.max(nowAt, dispatchAt)).toISOString() }),
    estimate: input.estimate,
    createdAt: new Date(nowAt).toISOString()
  };
}

export function isFulfillmentSlotAvailable(slot: FulfillmentSlot): boolean {
  return Boolean(slot.id.trim()) &&
    isValidOffsetDateTime(slot.startsAtUtc) &&
    isValidOffsetDateTime(slot.endsAtUtc) &&
    Date.parse(slot.endsAtUtc) > Date.parse(slot.startsAtUtc) &&
    Number.isInteger(slot.capacity) && slot.capacity > 0 &&
    Number.isInteger(slot.reservedCount) && slot.reservedCount >= 0 &&
    slot.reservedCount < slot.capacity;
}
