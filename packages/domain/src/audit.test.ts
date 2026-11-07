import { describe, expect, it } from "vitest";
import { createAuditEvent } from "./audit.js";

const baseEvent = {
  id: "evt_01",
  type: "order.status_changed",
  category: "order",
  occurredAt: "2026-11-07T12:00:00.000Z",
  actor: { id: "user_01", type: "merchant_user" as const, role: "branch_manager" },
  action: "update",
  outcome: "success" as const,
  correlationId: "corr_01",
  source: "orders-api",
  severity: "info" as const
};

describe("createAuditEvent", () => {
  it("creates a versioned event with actor and correlation context", () => {
    const event = createAuditEvent(baseEvent);
    expect(event.schemaVersion).toBe(1);
    expect(event.actor.id).toBe("user_01");
    expect(event.correlationId).toBe("corr_01");
  });

  it("redacts common secrets recursively", () => {
    const event = createAuditEvent({
      ...baseEvent,
      metadata: {
        orderId: "order_01",
        accessToken: "do-not-store",
        nested: { password: "hidden", count: 2 }
      }
    });
    expect(event.metadata).toEqual({
      orderId: "order_01",
      accessToken: "[REDACTED]",
      nested: { password: "[REDACTED]", count: 2 }
    });
  });

  it("limits metadata depth, collection size, and string length", () => {
    const event = createAuditEvent({
      ...baseEvent,
      metadata: {
        note: "x".repeat(1_200),
        items: Array.from({ length: 60 }, (_, index) => index),
        deep: { a: { b: { c: { d: { e: "hidden by depth" } } } } }
      }
    });
    expect(event.metadata.note).toHaveLength(1_000);
    expect(event.metadata.items).toHaveLength(50);
    expect(event.metadata.deep).toEqual({
      a: { b: { c: { d: "[TRUNCATED]" } } }
    });
  });
});
