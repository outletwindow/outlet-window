export const DELIVERY_METHODS = ["home_delivery", "store_pickup", "pickup_point"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export const DELIVERY_PHOTO_PURPOSES = [
  "entrance",
  "gate",
  "parking",
  "vehicle",
  "meeting_point",
  "other"
] as const;
export type DeliveryPhotoPurpose = (typeof DELIVERY_PHOTO_PURPOSES)[number];

/**
 * Metadata for a customer-uploaded location/access photo.
 * The binary is stored by a separately authorized media service; never embed it in an order event.
 */
export interface DeliveryInstructionPhoto {
  id: string;
  mediaAssetId: string;
  purpose: DeliveryPhotoPurpose;
  caption?: string;
  uploadedAt: string;
}

export type ContactPreference = "call" | "message";
export type DoorbellPreference = "ring" | "do_not_ring" | "no_preference";
export type HandoverPreference = "hand_to_customer" | "leave_at_door" | "no_preference";

export interface CustomerDeliveryInstructions {
  orderId: string;
  deliveryMethod: DeliveryMethod;
  /** Customer may select both call and message, either one, or neither. */
  contactPreferences: readonly ContactPreference[];
  handoverPreference: HandoverPreference;
  doorbellPreference: DoorbellPreference;
  accessNote?: string;
  photos: readonly DeliveryInstructionPhoto[];
  updatedAt: string;
}

export const MAX_DELIVERY_INSTRUCTION_PHOTOS = 8;
export const MAX_DELIVERY_CAPTION_LENGTH = 160;
export const MAX_DELIVERY_ACCESS_NOTE_LENGTH = 500;

/** Validate customer-provided instructions before persistence. Authorization and media ownership are checked separately. */
export function isCustomerDeliveryInstructionsValid(
  instructions: CustomerDeliveryInstructions
): boolean {
  if (!instructions.orderId.trim()) return false;
  if (!["home_delivery", "store_pickup", "pickup_point"].includes(instructions.deliveryMethod)) return false;
  if (!["hand_to_customer", "leave_at_door", "no_preference"].includes(instructions.handoverPreference)) return false;
  if (!["ring", "do_not_ring", "no_preference"].includes(instructions.doorbellPreference)) return false;
  if (!Array.isArray(instructions.contactPreferences) ||
      instructions.contactPreferences.some((value) => value !== "call" && value !== "message") ||
      new Set(instructions.contactPreferences).size !== instructions.contactPreferences.length) return false;
  if (!Array.isArray(instructions.photos) || instructions.photos.length > MAX_DELIVERY_INSTRUCTION_PHOTOS) return false;
  if (instructions.accessNote !== undefined && instructions.accessNote.length > MAX_DELIVERY_ACCESS_NOTE_LENGTH) return false;
  if (!Number.isFinite(Date.parse(instructions.updatedAt))) return false;

  const photoIds = new Set<string>();
  const assetIds = new Set<string>();
  for (const photo of instructions.photos) {
    if (!photo.id.trim() || !photo.mediaAssetId.trim()) return false;
    if (photoIds.has(photo.id) || assetIds.has(photo.mediaAssetId)) return false;
    photoIds.add(photo.id);
    assetIds.add(photo.mediaAssetId);
    if (!["entrance", "gate", "parking", "vehicle", "meeting_point", "other"].includes(photo.purpose)) return false;
    if (photo.caption !== undefined && photo.caption.length > MAX_DELIVERY_CAPTION_LENGTH) return false;
    if (!Number.isFinite(Date.parse(photo.uploadedAt))) return false;
  }

  // Collection instructions must not be interpreted as permission to leave goods unattended.
  if (instructions.deliveryMethod !== "home_delivery" &&
      instructions.handoverPreference === "leave_at_door") return false;
  return true;
}
