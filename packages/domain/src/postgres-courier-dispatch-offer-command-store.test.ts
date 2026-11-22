import { describe, expect, it, vi } from "vitest";
import { PostgresCourierDispatchOfferCommandStore } from "./postgres-courier-dispatch-offer-command-store.js";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";

function poolWith(rowsBySql: (sql: string, values?: readonly unknown[]) => { rows?: unknown[]; rowCount?: number }) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, ...(values === undefined ? {} : { values }) });
    const result = rowsBySql(sql, values);
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? (result.rows?.length ?? 0) };
  });
  const client = { query, release: vi.fn() } as unknown as PostgresClient;
  const pool = { connect: async () => client } as unknown as PostgresPool;
  return { pool, client, calls, query };
}

const offerRow = {
  id: "offer-1", tenant_id: "tenant-1", suborder_id: "suborder-1",
  courier_id: "courier-1", status: "offered", version: 2,
  expires_at: "2026-11-18T09:00:00.000Z"
};
const now = () => new Date("2026-11-18T08:30:00.000Z");

describe("PostgresCourierDispatchOfferCommandStore", () => {
  it("fails closed when authoritative courier eligibility is not configured", async () => {
    const { pool, query } = poolWith(() => ({ rows: [offerRow] }));
    const store = new PostgresCourierDispatchOfferCommandStore(pool, undefined, now);
    await expect(store.respond({
      tenantId: "tenant-1", offerId: "offer-1", courierId: "courier-1",
      expectedVersion: 2, decision: "accepted"
    })).resolves.toEqual({ outcome: "eligibility_unavailable" });
    expect(query).not.toHaveBeenCalled();
  });

  it("declines an offer with optimistic version and append-only event in one transaction", async () => {
    const { pool, calls, query, client } = poolWith(sql => {
      if (sql.includes("FROM courier_dispatch_offers o")) return { rows: [offerRow] };
      if (sql.includes("MAX(sequence)")) return { rows: [{ next_sequence: 1 }] };
      if (sql.includes("UPDATE courier_dispatch_offers")) return { rowCount: 1 };
      return { rowCount: 1 };
    });
    const store = new PostgresCourierDispatchOfferCommandStore(pool, undefined, now);
    await expect(store.respond({
      tenantId: "tenant-1", offerId: "offer-1", courierId: "courier-1",
      expectedVersion: 2, decision: "declined", reason: "vehicle unavailable"
    })).resolves.toEqual({ outcome: "declined", offerVersion: 3 });
    expect(calls.some(call => call.sql.includes("FOR UPDATE OF o, s"))).toBe(true);
    expect(query).toHaveBeenCalledWith("BEGIN");
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(calls.some(call => call.sql.includes("courier_dispatch_offer_events"))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("creates one assigned task only after eligibility is rechecked in the locked transaction", async () => {
    const { pool, calls, query } = poolWith(sql => {
      if (sql.includes("FROM courier_dispatch_offers o")) return { rows: [offerRow] };
      if (sql.includes("FROM courier_delivery_tasks")) return { rows: [] };
      if (sql.includes("MAX(sequence)")) return { rows: [{ next_sequence: 1 }] };
      if (sql.includes("UPDATE courier_dispatch_offers")) return { rowCount: 1 };
      return { rowCount: 1 };
    });
    const isEligible = vi.fn(async ({ client }: { client: PostgresClient }) => {
      expect(client).toBeTruthy();
      return true;
    });
    const store = new PostgresCourierDispatchOfferCommandStore(pool, { isEligible }, now);
    const result = await store.respond({
      tenantId: "tenant-1", offerId: "offer-1", courierId: "courier-1",
      expectedVersion: 2, decision: "accepted"
    });
    expect(result).toMatchObject({ outcome: "accepted", offerVersion: 3 });
    expect(isEligible).toHaveBeenCalledOnce();
    const taskInsert = calls.find(call => call.sql.includes("INSERT INTO courier_delivery_tasks"));
    expect(taskInsert?.sql).toContain("'accepted'");
    expect(calls.some(call => call.sql.includes("courier_delivery_task_events"))).toBe(true);
    expect(calls.some(call => call.sql.includes("courier_dispatch_offer_events"))).toBe(true);
    expect(query).toHaveBeenCalledWith("COMMIT");
  });

  it("rolls back when the courier is no longer eligible", async () => {
    const { pool, calls, query } = poolWith(sql => {
      if (sql.includes("FROM courier_dispatch_offers o")) return { rows: [offerRow] };
      return { rowCount: 1 };
    });
    const store = new PostgresCourierDispatchOfferCommandStore(pool, { isEligible: async () => false }, now);
    await expect(store.respond({
      tenantId: "tenant-1", offerId: "offer-1", courierId: "courier-1",
      expectedVersion: 2, decision: "accepted"
    })).resolves.toEqual({ outcome: "courier_ineligible" });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(calls.some(call => call.sql.includes("INSERT INTO courier_delivery_tasks"))).toBe(false);
  });

  it("expires an offer atomically rather than accepting after its deadline", async () => {
    const { pool, calls, query } = poolWith(sql => {
      if (sql.includes("FROM courier_dispatch_offers o")) return {
        rows: [{ ...offerRow, expires_at: "2026-11-18T08:00:00.000Z" }]
      };
      if (sql.includes("MAX(sequence)")) return { rows: [{ next_sequence: 1 }] };
      return { rowCount: 1 };
    });
    const store = new PostgresCourierDispatchOfferCommandStore(pool, undefined, now);
    await expect(store.respond({
      tenantId: "tenant-1", offerId: "offer-1", courierId: "courier-1",
      expectedVersion: 2, decision: "declined", reason: "too late"
    })).resolves.toEqual({ outcome: "expired" });
    expect(calls.some(call => call.sql.includes("SET status = 'expired'"))).toBe(true);
    expect(query).toHaveBeenCalledWith("COMMIT");
  });
});
