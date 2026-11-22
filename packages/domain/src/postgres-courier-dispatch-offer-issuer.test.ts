import { describe, expect, it, vi } from "vitest";
import { PostgresCourierDispatchOfferIssuer } from "./postgres-courier-dispatch-offer-issuer.js";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";

function createPool(handler: (sql: string, values?: readonly unknown[]) => { rows?: unknown[]; rowCount?: number }) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, ...(values === undefined ? {} : { values }) });
    const result = handler(sql, values);
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? (result.rows?.length ?? 0) };
  });
  const client = { query, release: vi.fn() } as unknown as PostgresClient;
  const pool = { connect: async () => client } as unknown as PostgresPool;
  return { pool, client, calls, query };
}
const now = () => new Date("2026-11-22T08:00:00.000Z");
const input = {
  tenantId: "merchant-1", suborderId: "suborder-1",
  courierIds: ["courier-a", "courier-b"],
  expiresAtUtc: "2026-11-22T08:05:00.000Z", dispatcherId: "dispatcher-1"
};

describe("PostgresCourierDispatchOfferIssuer", () => {
  it("creates offers and immutable initial events only for eligible couriers", async () => {
    const { pool, calls, query, client } = createPool(sql => {
      if (sql.includes("FROM merchant_suborders")) return { rows: [{ status: "ready_for_pickup" }] };
      if (sql.includes("FROM courier_delivery_tasks")) return { rows: [] };
      if (sql.includes("INSERT INTO courier_dispatch_offers")) return { rows: [{ id: "offer-created" }] };
      return { rowCount: 1 };
    });
    const isEligible = vi.fn(async ({ courierId }: { courierId: string }) => courierId === "courier-a");
    const issuer = new PostgresCourierDispatchOfferIssuer(pool, { isEligible }, now);
    await expect(issuer.issue(input)).resolves.toEqual({
      created: [{ offerId: expect.any(String), courierId: "courier-a" }],
      skipped: [{ courierId: "courier-b", reason: "ineligible" }]
    });
    expect(isEligible).toHaveBeenCalledTimes(2);
    expect(calls.some(call => call.sql.includes("FOR UPDATE"))).toBe(true);
    expect(calls.some(call => call.sql.includes("courier_dispatch_offer_events"))).toBe(true);
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("checks overlapping courier candidates in stable ID order", async () => {
    const { pool } = createPool(sql => {
      if (sql.includes("FROM merchant_suborders")) return { rows: [{ status: "ready_for_pickup" }] };
      if (sql.includes("FROM courier_delivery_tasks")) return { rows: [] };
      if (sql.includes("INSERT INTO courier_dispatch_offers")) return { rows: [{ id: "offer-created" }] };
      return { rowCount: 1 };
    });
    const checked: string[] = [];
    const issuer = new PostgresCourierDispatchOfferIssuer(pool, {
      async isEligible({ courierId }) { checked.push(courierId); return true; }
    }, now);
    await issuer.issue({ ...input, courierIds: ["courier-z", "courier-a"] });
    expect(checked).toEqual(["courier-a", "courier-z"]);
  });

  it("skips a courier who already has a pending offer without duplicating it", async () => {
    const { pool, calls } = createPool(sql => {
      if (sql.includes("FROM merchant_suborders")) return { rows: [{ status: "ready_for_pickup" }] };
      if (sql.includes("FROM courier_delivery_tasks")) return { rows: [] };
      if (sql.includes("INSERT INTO courier_dispatch_offers")) return { rows: [] };
      return { rowCount: 1 };
    });
    const issuer = new PostgresCourierDispatchOfferIssuer(pool, { isEligible: async () => true }, now);
    await expect(issuer.issue({ ...input, courierIds: ["courier-a"] })).resolves.toEqual({
      created: [], skipped: [{ courierId: "courier-a", reason: "already_offered" }]
    });
    expect(calls.some(call => call.sql.includes("courier_dispatch_offer_events"))).toBe(false);
  });

  it("fails closed when the suborder is not ready for pickup", async () => {
    const { pool, query, calls } = createPool(sql =>
      sql.includes("FROM merchant_suborders") ? { rows: [{ status: "preparing" }] } : { rowCount: 1 }
    );
    const issuer = new PostgresCourierDispatchOfferIssuer(pool, { isEligible: async () => true }, now);
    await expect(issuer.issue(input)).rejects.toThrow("courier_dispatch_suborder_not_ready");
    expect(calls.some(call => call.sql.includes("INSERT INTO courier_dispatch_offers"))).toBe(false);
    expect(query.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(1);
  });

  it("refuses invalid expiry, duplicate couriers, and oversized batches before opening a transaction", async () => {
    const { pool, query } = createPool(() => ({ rowCount: 1 }));
    const issuer = new PostgresCourierDispatchOfferIssuer(pool, { isEligible: async () => true }, now);
    await expect(issuer.issue({ ...input, expiresAtUtc: "2026-11-22T08:00:00.000Z" }))
      .rejects.toThrow("invalid_courier_dispatch_offer_issue");
    await expect(issuer.issue({ ...input, courierIds: ["courier-a", "courier-a"] }))
      .rejects.toThrow("invalid_courier_dispatch_offer_issue");
    await expect(issuer.issue({ ...input, courierIds: Array.from({ length: 101 }, (_, i) => "courier-" + i) }))
      .rejects.toThrow("invalid_courier_dispatch_offer_issue");
    expect(query).not.toHaveBeenCalled();
  });
});
