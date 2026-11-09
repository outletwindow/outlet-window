import { describe, expect, it, vi } from "vitest";
import { PostgresFulfillmentProviderScopeAuthorizer } from "./postgres-fulfillment-provider-scope-authorizer.js";
import type { VerifiedFulfillmentHandoverEvent } from "./fulfillment-handover-provider.js";
import type { PostgresQueryable } from "./postgres-iam-store.js";

const event: VerifiedFulfillmentHandoverEvent = {
  providerKey: "carrier-a", providerEventId: "event-1", eventType: "handover.completed",
  tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1",
  reservationId: "reservation-1", handoverReference: "carrier-a:handover-1",
  occurredAtUtc: "2026-11-09T10:00:00.000Z"
};

describe("PostgresFulfillmentProviderScopeAuthorizer", () => {
  it("authorizes only a connected carrier with an active exact branch grant", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [{ authorized: true }], rowCount: 1 }));
    const authorizer = new PostgresFulfillmentProviderScopeAuthorizer({ query } as unknown as PostgresQueryable);
    await expect(authorizer.isAuthorized("carrier-a", event)).resolves.toBe(true);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual(["tenant-1", "carrier-a", "merchant-1", "branch-1"]);
    expect(String(query.mock.calls[0]?.[0])).toContain("i.status = 'connected'");
    expect(String(query.mock.calls[0]?.[0])).toContain("SELECT COUNT(*) = 1");
    expect(String(query.mock.calls[0]?.[0])).toContain("s.active = true");
  });

  it("fails closed when no exact provider branch grant exists", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [{ authorized: false }], rowCount: 1 }));
    const authorizer = new PostgresFulfillmentProviderScopeAuthorizer({ query } as unknown as PostgresQueryable);
    await expect(authorizer.isAuthorized("carrier-a", event)).resolves.toBe(false);
  });

  it("fails closed when the database returns no authorization row", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] as { authorized: boolean }[], rowCount: 0 }));
    const authorizer = new PostgresFulfillmentProviderScopeAuthorizer({ query } as unknown as PostgresQueryable);
    await expect(authorizer.isAuthorized("carrier-a", event)).resolves.toBe(false);
  });
});
