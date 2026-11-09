import { createHmac, timingSafeEqual } from "node:crypto";

/** Normalized proof emitted only after verifying a provider's raw-body signature. */
export interface VerifiedFulfillmentHandoverEvent {
  providerKey: string;
  providerEventId: string;
  eventType: "handover.completed";
  tenantId: string;
  merchantId: string;
  branchId: string;
  reservationId: string;
  handoverReference: string;
  occurredAtUtc: string;
}

function boundedIdentifier(value: unknown, max = 200): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= max && value === value.trim();
}

/** Parse a strict timestamped HMAC header without accepting duplicate or unknown fields. */
function verifySignature(input: {
  rawBody: string;
  signatureHeader: string | undefined;
  secret: string | undefined;
  nowUtc: Date;
  toleranceSeconds: number;
}): boolean {
  if (!input.secret || input.secret.length < 32 || !input.signatureHeader ||
      Buffer.byteLength(input.rawBody, "utf8") > 65_536) return false;

  const fields = new Map<string, string>();
  for (const part of input.signatureHeader.split(",")) {
    const index = part.indexOf("=");
    if (index < 1) return false;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if ((key !== "t" && key !== "v1") || fields.has(key) || !value) return false;
    fields.set(key, value);
  }
  const timestampText = fields.get("t");
  const signatureText = fields.get("v1");
  if (!/^\d{10}$/.test(timestampText ?? "") ||
      !/^[a-f0-9]{64}$/i.test(signatureText ?? "")) return false;

  const timestamp = Number(timestampText);
  const nowSeconds = Math.floor(input.nowUtc.getTime() / 1000);
  if (!Number.isSafeInteger(nowSeconds) ||
      Math.abs(nowSeconds - timestamp) > input.toleranceSeconds) return false;

  const expected = createHmac("sha256", input.secret)
    .update(timestampText + "." + input.rawBody, "utf8").digest();
  const supplied = Buffer.from(signatureText!, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * Verifies the provider signature before parsing or trusting any event fields.
 * Provider task acceptance receipts are deliberately not accepted as handover proof.
 */
export function verifyAndParseFulfillmentHandoverEvent(input: {
  providerKey: string;
  rawBody: string;
  signatureHeader: string | undefined;
  secret: string | undefined;
  nowUtc?: Date;
  toleranceSeconds?: number;
}): VerifiedFulfillmentHandoverEvent | null {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(input.providerKey) ||
      typeof input.rawBody !== "string" || input.rawBody.length === 0 ||
      Buffer.byteLength(input.rawBody, "utf8") > 65_536) return null;
  const toleranceSeconds = input.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 30 ||
      toleranceSeconds > 600) return null;

  if (!verifySignature({
    rawBody: input.rawBody, signatureHeader: input.signatureHeader,
    secret: input.secret, nowUtc: input.nowUtc ?? new Date(), toleranceSeconds
  })) return null;

  let payload: unknown;
  try { payload = JSON.parse(input.rawBody) as unknown; } catch { return null; }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const event = payload as Record<string, unknown>;
  if (event.eventType !== "handover.completed" ||
      !boundedIdentifier(event.providerEventId, 240) ||
      !boundedIdentifier(event.tenantId) ||
      !boundedIdentifier(event.merchantId) ||
      !boundedIdentifier(event.branchId) ||
      !boundedIdentifier(event.reservationId) ||
      !boundedIdentifier(event.handoverReference, 240) ||
      !boundedIdentifier(event.occurredAtUtc, 40) ||
      !Number.isFinite(Date.parse(event.occurredAtUtc))) return null;

  return {
    providerKey: input.providerKey,
    providerEventId: event.providerEventId,
    eventType: "handover.completed",
    tenantId: event.tenantId,
    merchantId: event.merchantId,
    branchId: event.branchId,
    reservationId: event.reservationId,
    // Namespace references so two providers cannot collide or replay each other's IDs.
    handoverReference: input.providerKey + ":" + event.handoverReference,
    occurredAtUtc: new Date(event.occurredAtUtc).toISOString()
  };
}
