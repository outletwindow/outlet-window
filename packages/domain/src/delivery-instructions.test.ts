import { describe, expect, it } from "vitest";
import {
  isCustomerDeliveryInstructionsValid,
  MAX_DELIVERY_INSTRUCTION_PHOTOS,
  type CustomerDeliveryInstructions
} from "./delivery-instructions.js";

const valid: CustomerDeliveryInstructions = {
  orderId: "order-1",
  deliveryMethod: "home_delivery",
  contactPreferences: ["call", "message"],
  handoverPreference: "leave_at_door",
  doorbellPreference: "do_not_ring",
  accessNote: "Gate is beside the visitor parking.",
  photos: [
    { id: "photo-1", mediaAssetId: "asset-1", purpose: "gate", caption: "Use this gate", uploadedAt: "2026-11-07T12:00:00.000Z" },
    { id: "photo-2", mediaAssetId: "asset-2", purpose: "parking", uploadedAt: "2026-11-07T12:01:00.000Z" }
  ],
  updatedAt: "2026-11-07T12:02:00.000Z"
};

describe("customer delivery instruction contracts", () => {
  it("accepts multiple access photos and optional contact preferences", () => {
    expect(isCustomerDeliveryInstructionsValid(valid)).toBe(true);
  });

  it("allows all contact and bell preferences to be disabled", () => {
    expect(isCustomerDeliveryInstructionsValid({
      ...valid,
      contactPreferences: [],
      handoverPreference: "hand_to_customer",
      doorbellPreference: "no_preference"
    })).toBe(true);
  });

  it("rejects more than the configured photo limit", () => {
    const photos = Array.from({ length: MAX_DELIVERY_INSTRUCTION_PHOTOS + 1 }, (_, i) => ({
      id: `photo-${i}`, mediaAssetId: `asset-${i}`, purpose: "other" as const,
      uploadedAt: "2026-11-07T12:00:00.000Z"
    }));
    expect(isCustomerDeliveryInstructionsValid({ ...valid, photos })).toBe(false);
  });

  it("rejects leaving an order unattended for store pickup", () => {
    expect(isCustomerDeliveryInstructionsValid({
      ...valid,
      deliveryMethod: "store_pickup",
      handoverPreference: "leave_at_door"
    })).toBe(false);
  });

  it("rejects duplicate media assets and invalid timestamps", () => {
    expect(isCustomerDeliveryInstructionsValid({
      ...valid,
      photos: [valid.photos[0]!, { ...valid.photos[1]!, mediaAssetId: "asset-1" }]
    })).toBe(false);
    expect(isCustomerDeliveryInstructionsValid({
      ...valid,
      updatedAt: "not-a-date"
    })).toBe(false);
  });
});
