import { describe, expect, it, vi } from "vitest";
import { PostgresCourierDispatchOfferEligibility } from "./postgres-courier-dispatch-offer-eligibility.js";
import type { PostgresClient } from "./postgres-iam-store.js";

describe("PostgresCourierDispatchOfferEligibility", () => {
  it("requires current persisted profile and vehicle eligibility plus spare workload capacity", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ max_concurrent_tasks: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ active_count: 1 }], rowCount: 1 });
    const client = { query } as unknown as PostgresClient;
    const eligibility = new PostgresCourierDispatchOfferEligibility();
    await expect(eligibility.isEligible({
      client, tenantId: "merchant-1", courierId: "courier-1", suborderId: "suborder-1"
    })).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("FOR UPDATE OF p, a");
    expect(query.mock.calls[0]?.[0]).toContain("a.updated_at >= now() - interval '2 minutes'");
    expect(query.mock.calls[1]?.[0]).toContain("status NOT IN ('declined','cancelled','failed')");
  });

  it("fails closed when the courier profile, heartbeat, zone or vehicle is not eligible", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const client = { query } as unknown as PostgresClient;
    const eligibility = new PostgresCourierDispatchOfferEligibility();
    await expect(eligibility.isEligible({
      client, tenantId: "merchant-1", courierId: "courier-1", suborderId: "suborder-1"
    })).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects a courier at the concurrent task limit", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ max_concurrent_tasks: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ active_count: 1 }], rowCount: 1 });
    const client = { query } as unknown as PostgresClient;
    const eligibility = new PostgresCourierDispatchOfferEligibility();
    await expect(eligibility.isEligible({
      client, tenantId: "merchant-1", courierId: "courier-1", suborderId: "suborder-1"
    })).resolves.toBe(false);
  });
});
