import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAndParseFulfillmentHandoverEvent } from "./fulfillment-handover-provider.js";

const secret = "fulfillment-webhook-secret-that-is-at-least-32-bytes";
const nowUtc = new Date("2026-11-09T10:00:00.000Z");
const payload = {
  eventType: "handover.completed",
  providerEventId: "event-001",
  tenantId: "tenant-1",
  merchantId: "merchant-1",
  branchId: "branch-1",
  reservationId: "reservation-1",
  handoverReference: "handover-001",
  occurredAtUtc: "2026-11-09T09:59:30.000Z"
};
function signed(rawBody: string, timestamp = Math.floor(nowUtc.getTime() / 1000)) {
  const t = String(timestamp);
  const v1 = createHmac("sha256", secret).update(t + "." + rawBody).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("signed fulfillment handover event verification", () => {
  it("normalizes only a correctly signed completion event and namespaces its reference", () => {
    const rawBody = JSON.stringify(payload);
    expect(verifyAndParseFulfillmentHandoverEvent({
      providerKey: "carrier-a", rawBody, signatureHeader: signed(rawBody),
      secret, nowUtc
    })).toEqual({
      providerKey: "carrier-a", providerEventId: "event-001",
      eventType: "handover.completed", tenantId: "tenant-1",
      merchantId: "merchant-1", branchId: "branch-1",
      reservationId: "reservation-1",
      handoverReference: "carrier-a:handover-001",
      occurredAtUtc: "2026-11-09T09:59:30.000Z"
    });
  });

  it("rejects tampered raw bodies and invalid signatures", () => {
    const rawBody = JSON.stringify(payload);
    expect(verifyAndParseFulfillmentHandoverEvent({
      providerKey: "carrier-a", rawBody: rawBody + " ",
      signatureHeader: signed(rawBody), secret, nowUtc
    })).toBeNull();
  });

  it("rejects stale signatures, weak secrets, and duplicate signature fields", () => {
    const rawBody = JSON.stringify(payload);
    expect(verifyAndParseFulfillmentHandoverEvent({
      providerKey: "carrier-a", rawBody,
      signatureHeader: signed(rawBody, Math.floor(nowUtc.getTime() / 1000) - 1000),
      secret, nowUtc
    })).toBeNull();
    expect(verifyAndParseFulfillmentHandoverEvent({
      providerKey: "carrier-a", rawBody, signatureHeader: signed(rawBody),
      secret: "weak", nowUtc
    })).toBeNull();
    expect(verifyAndParseFulfillmentHandoverEvent({
      providerKey: "carrier-a", rawBody,
      signatureHeader: signed(rawBody) + ",t=1794218400",
      secret, nowUtc
    })).toBeNull();
  });

  it("rejects malformed payloads and task-accepted events", () => {
    for (const invalid of [
      { ...payload, eventType: "task.accepted" },
      { ...payload, branchId: "" },
      { ...payload, occurredAtUtc: "not-a-date" }
    ]) {
      const rawBody = JSON.stringify(invalid);
      expect(verifyAndParseFulfillmentHandoverEvent({
        providerKey: "carrier-a", rawBody, signatureHeader: signed(rawBody),
        secret, nowUtc
      })).toBeNull();
    }
  });
});
