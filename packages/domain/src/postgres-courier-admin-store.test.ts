import { describe, expect, it, vi } from "vitest";
import { PostgresCourierAdminStore } from "./postgres-courier-admin-store.js";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";

function makePool(responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn(async (_sql: string) => {
    const next = responses.shift() ?? { rows: [], rowCount: 0 };
    return { rows: next.rows ?? [], rowCount: next.rowCount ?? (next.rows?.length ?? 0) };
  });
  const client = { query, release: vi.fn() } as unknown as PostgresClient;
  const pool = { connect: async () => client, query } as unknown as PostgresPool;
  return { pool, query, client };
}

describe("PostgresCourierAdminStore", () => {
  const now = () => new Date("2026-11-19T10:00:00.000Z");

  it("creates a pending profile only for an active human identity", async () => {
    const { pool, query } = makePool([
      {}, { rows: [{ id: "courier-1", principal_type: "human", status: "active" }] },
      { rows: [{ courier_id: "courier-1" }] }, {}
    ]);
    const store = new PostgresCourierAdminStore(pool, now);
    await expect(store.createProfile({ courierId: "courier-1", maxConcurrentTasks: 2 })).resolves.toBe("created");
    expect(query.mock.calls[2]?.[0]).toContain("'pending', 'pending'");
    expect(query).toHaveBeenCalledWith("COMMIT");
  });

  it("rejects service identities for courier onboarding", async () => {
    const { pool, query } = makePool([
      {}, { rows: [{ id: "service-1", principal_type: "integration", status: "active" }] }, {}
    ]);
    const store = new PostgresCourierAdminStore(pool, now);
    await expect(store.createProfile({ courierId: "service-1", maxConcurrentTasks: 1 })).resolves.toBe("identity_not_eligible");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("approves a pending profile and records the reviewer", async () => {
    const { pool, query } = makePool([
      {}, { rows: [{ account_status: "pending", verification_status: "pending" }] }, {}, {}
    ]);
    const store = new PostgresCourierAdminStore(pool, now);
    await expect(store.reviewProfile({ courierId: "courier-1", decision: "approve", reviewerId: "admin-1" }))
      .resolves.toBe("updated");
    expect(query.mock.calls[2]?.[0]).toContain("approved_by = CASE WHEN $3 = 'verified' THEN $4");
    expect(query).toHaveBeenCalledWith("COMMIT");
  });

  it("suspends an active courier and forces availability offline", async () => {
    const { pool, query } = makePool([
      {}, { rows: [{ account_status: "active", verification_status: "verified" }] }, {}, {}, {}
    ]);
    const store = new PostgresCourierAdminStore(pool, now);
    await expect(store.reviewProfile({ courierId: "courier-1", decision: "suspend", reviewerId: "admin-1" }))
      .resolves.toBe("updated");
    expect(query.mock.calls[3]?.[0]).toContain("SET available = false");
  });

  it("does not allow approving a profile in an invalid state", async () => {
    const { pool, query } = makePool([
      {}, { rows: [{ account_status: "active", verification_status: "verified" }] }, {}
    ]);
    const store = new PostgresCourierAdminStore(pool, now);
    await expect(store.reviewProfile({ courierId: "courier-1", decision: "approve", reviewerId: "admin-1" }))
      .resolves.toBe("invalid_transition");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("registers a vehicle as pending and inactive for an approved courier", async () => {
    const { pool, query } = makePool([
      {}, { rows: [{ account_status: "active", verification_status: "verified" }] },
      { rows: [{ id: "vehicle-1" }] }, {}
    ]);
    const store = new PostgresCourierAdminStore(pool, now);
    await expect(store.registerVehicle({
      vehicleId: "vehicle-1", courierId: "courier-1", vehicleType: "car",
      capacityWeightGrams: 100000, capacityVolumeLiters: 500
    })).resolves.toBe("created");
    expect(query.mock.calls[2]?.[0]).toContain("'pending',$4,$5,false");
    expect(query).toHaveBeenCalledWith("COMMIT");
  });

  it("approves a pending vehicle and records reviewer identity", async () => {
    const { pool, query } = makePool([
      {}, { rows: [{ verification_status: "pending", courier_id: "courier-1" }] }, {}, {}
    ]);
    const store = new PostgresCourierAdminStore(pool, now);
    await expect(store.reviewVehicle({ vehicleId: "vehicle-1", decision: "approve", reviewerId: "admin-1" }))
      .resolves.toBe("updated");
    expect(query.mock.calls[2]?.[0]).toContain("verified_by = CASE WHEN $3 THEN $4");
  });

  it("grants a service area only when the courier and area are eligible", async () => {
    const { pool, query } = makePool([
      {}, { rows: [{ account_status: "active", verification_status: "verified" }] },
      { rows: [{ id: "area-1" }] }, {}, {}
    ]);
    const store = new PostgresCourierAdminStore(pool, now);
    await expect(store.grantServiceArea({
      courierId: "courier-1", tenantId: "tenant-1", serviceAreaId: "area-1", reviewerId: "admin-1"
    })).resolves.toBe("granted");
    expect(query.mock.calls[2]?.[0]).toContain("status = 'active'");
    expect(query.mock.calls[3]?.[0]).toContain("ON CONFLICT (courier_id, tenant_id, service_area_id)");
  });

  it("revokes only an active service-area membership", async () => {
    const { pool } = makePool([]);
    (pool as unknown as { query: ReturnType<typeof vi.fn> }).query.mockResolvedValue({ rows: [], rowCount: 1 });
    const store = new PostgresCourierAdminStore(pool, now);
    await expect(store.revokeServiceArea({ courierId: "courier-1", tenantId: "tenant-1", serviceAreaId: "area-1" }))
      .resolves.toBe("revoked");
  });

});
