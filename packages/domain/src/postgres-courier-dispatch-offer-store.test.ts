import { describe, expect, it, vi } from "vitest";
import { PostgresCourierDispatchOfferStore } from "./postgres-courier-dispatch-offer-store.js";
import type { PostgresPool } from "./postgres-iam-store.js";

describe("PostgresCourierDispatchOfferStore", () => {
  it("returns only the authenticated courier's unexpired offers within the tenant", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        id: "offer-1", suborder_id: "suborder-1", status: "offered" as const,
        version: 3, offered_at: "2026-11-17T10:00:00.000Z",
        expires_at: "2026-11-17T10:05:00.000Z"
      }],
      rowCount: 1
    }));
    const pool = { query } as unknown as PostgresPool;
    const now = new Date("2026-11-17T10:02:00.000Z");
    const store = new PostgresCourierDispatchOfferStore(pool, () => now);
    await expect(store.listForCourier({
      tenantId: "tenant-1", courierId: "courier-1", limit: 500
    })).resolves.toEqual([{
      id: "offer-1", suborderId: "suborder-1", status: "offered",
      version: 3, offeredAtUtc: "2026-11-17T10:00:00.000Z",
      expiresAtUtc: "2026-11-17T10:05:00.000Z"
    }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("expires_at > $3"), [
      "tenant-1", "courier-1", now, 100
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("tenant_id = $1 AND courier_id = $2");
  });

  it("returns an empty inbox without inventing offers", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as PostgresPool;
    const store = new PostgresCourierDispatchOfferStore(pool);
    await expect(store.listForCourier({ tenantId: "tenant-1", courierId: "courier-1" }))
      .resolves.toEqual([]);
  });
});
