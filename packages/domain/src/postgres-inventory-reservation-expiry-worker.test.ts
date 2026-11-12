import { describe, expect, it } from "vitest";
import type { PostgresClient, PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresInventoryReservationExpiryWorker } from "./postgres-inventory-reservation-expiry-worker.js";

class DueReservationPool implements PostgresPool {
  values: readonly unknown[] = [];
  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    this.values = values;
    expect(sql).toContain("status = 'reserved'");
    expect(sql).toContain("expires_at <= $1");
    return { rows: [
      { tenant_id: "tenant-1", merchant_id: "merchant-1", branch_id: "branch-1", id: "reservation-1" },
      { tenant_id: "tenant-1", merchant_id: "merchant-1", branch_id: "branch-2", id: "reservation-2" },
      { tenant_id: "tenant-2", merchant_id: "merchant-2", branch_id: "branch-3", id: "reservation-3" }
    ] as Row[], rowCount: 3 };
  }
  async connect(): Promise<PostgresClient> { throw new Error("not_used"); }
}

describe("PostgreSQL inventory reservation expiry worker", () => {
  it("expires due reservations using each persisted tenant, merchant, and branch scope", async () => {
    const pool = new DueReservationPool();
    const received: unknown[] = [];
    const worker = new PostgresInventoryReservationExpiryWorker(pool, {
      async expire(input) {
        received.push(input);
        if (input.reservationId === "reservation-1") return { outcome: "updated", status: "expired" };
        if (input.reservationId === "reservation-2") return { outcome: "already_finalized", status: "released" };
        return { outcome: "not_found" };
      }
    });
    const result = await worker.runOnce({ nowUtc: "2026-11-09T10:00:00.000Z", limit: 20 });
    expect(pool.values).toEqual(["2026-11-09T10:00:00.000Z", 20]);
    expect(received).toEqual([
      { tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1", reservationId: "reservation-1", nowUtc: "2026-11-09T10:00:00.000Z" },
      { tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-2", reservationId: "reservation-2", nowUtc: "2026-11-09T10:00:00.000Z" },
      { tenantId: "tenant-2", merchantId: "merchant-2", branchId: "branch-3", reservationId: "reservation-3", nowUtc: "2026-11-09T10:00:00.000Z" }
    ]);
    expect(result).toEqual({ selected: 3, expired: 1, alreadyFinalized: 1, notFound: 1, failed: 0 });
  });

  it("counts an individual failure and continues processing the remaining reservations", async () => {
    const worker = new PostgresInventoryReservationExpiryWorker(new DueReservationPool(), {
      async expire(input) {
        if (input.reservationId === "reservation-1") throw new Error("database_timeout");
        return { outcome: "updated", status: "expired" };
      }
    });
    const result = await worker.runOnce({ nowUtc: "2026-11-09T10:00:00.000Z" });
    expect(result).toEqual({ selected: 3, expired: 2, alreadyFinalized: 0, notFound: 0, failed: 1 });
  });

  it("rejects invalid batch times and limits before querying", async () => {
    let queries = 0;
    const pool = new DueReservationPool();
    pool.query = async function<Row>() {
      queries += 1;
      return { rows: [], rowCount: 0 };
    };
    const worker = new PostgresInventoryReservationExpiryWorker(pool, {
      async expire() { return { outcome: "not_found" }; }
    });
    await expect(worker.runOnce({ nowUtc: "invalid" })).rejects.toThrow("invalid_inventory_reservation_expiry_batch");
    await expect(worker.runOnce({ nowUtc: "2026-11-09T10:00:00.000Z", limit: 501 })).rejects.toThrow("invalid_inventory_reservation_expiry_batch");
    expect(queries).toBe(0);
  });
});
