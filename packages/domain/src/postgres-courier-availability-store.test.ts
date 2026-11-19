import { describe, expect, it, vi } from "vitest";
import { PostgresCourierAvailabilityStore } from "./postgres-courier-availability-store.js";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";

function makePool(responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    const next = responses.shift() ?? { rows: [], rowCount: 0 };
    return { rows: next.rows ?? [], rowCount: next.rowCount ?? (next.rows?.length ?? 0) };
  });
  const client = { query, release: vi.fn() } as unknown as PostgresClient;
  const pool = { connect: async () => client } as unknown as PostgresPool;
  return { pool, query, client, calls };
}

describe("PostgresCourierAvailabilityStore", () => {
  const now = () => new Date("2026-11-19T10:00:00.000Z");

  it("updates availability and heartbeat for an active verified courier with a verified vehicle", async () => {
    const { pool, query } = makePool([
      {},
      { rows: [{ account_status: "active", verification_status: "verified" }] },
      { rows: [{ id: "vehicle-1" }] },
      { rows: [{ updated_at: "2026-11-19T10:00:00.000Z" }] }
    ]);
    const store = new PostgresCourierAvailabilityStore(pool, now);
    await expect(store.setAvailability({ courierId: "courier-1", available: true })).resolves.toEqual({
      outcome: "updated", available: true, updatedAtUtc: "2026-11-19T10:00:00.000Z"
    });
    expect(query.mock.calls[0]?.[0]).toContain("FOR UPDATE OF p");
    expect(query.mock.calls[2]?.[0]).toContain("ON CONFLICT (courier_id) DO UPDATE");
    expect(query).toHaveBeenCalledWith("COMMIT");
  });

  it("does not turn on availability for an unverified courier", async () => {
    const { pool, query } = makePool([
      {},
      { rows: [{ account_status: "pending", verification_status: "pending" }] }
    ]);
    const store = new PostgresCourierAvailabilityStore(pool, now);
    await expect(store.setAvailability({ courierId: "courier-1", available: true }))
      .resolves.toEqual({ outcome: "not_eligible" });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query.mock.calls.some(call => call[0].includes("INSERT INTO courier_availability"))).toBe(false);
  });

  it("requires a verified active vehicle before going online", async () => {
    const { pool, query } = makePool([
      {},
      { rows: [{ account_status: "active", verification_status: "verified" }] },
      { rows: [] }
    ]);
    const store = new PostgresCourierAvailabilityStore(pool, now);
    await expect(store.setAvailability({ courierId: "courier-1", available: true }))
      .resolves.toEqual({ outcome: "not_eligible" });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("returns not found when the authenticated identity has no courier profile", async () => {
    const { pool, query } = makePool([{}, { rows: [] }]);
    const store = new PostgresCourierAvailabilityStore(pool, now);
    await expect(store.setAvailability({ courierId: "courier-1", available: false }))
      .resolves.toEqual({ outcome: "not_found" });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("allows an approved courier to go offline without requiring a vehicle check", async () => {
    const { pool, query } = makePool([
      {},
      { rows: [{ account_status: "suspended", verification_status: "rejected" }] },
      { rows: [{ updated_at: "2026-11-19T10:00:00.000Z" }] }
    ]);
    const store = new PostgresCourierAvailabilityStore(pool, now);
    await expect(store.setAvailability({ courierId: "courier-1", available: false }))
      .resolves.toMatchObject({ outcome: "updated", available: false });
    expect(query.mock.calls.some(call => call[0].includes("FROM courier_vehicles"))).toBe(false);
  });
});
