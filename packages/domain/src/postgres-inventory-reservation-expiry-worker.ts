import type { PostgresPool } from "./postgres-iam-store.js";
import type { PostgresBranchInventoryReservationLifecycle } from "./postgres-branch-inventory-reservation-lifecycle.js";

export interface DueInventoryReservation {
  tenantId: string;
  merchantId: string;
  branchId: string;
  reservationId: string;
}

export interface InventoryReservationExpiryBatchResult {
  selected: number;
  expired: number;
  alreadyFinalized: number;
  notFound: number;
  failed: number;
}

/**
 * Finds due reservations and delegates each transition to the row-locking,
 * branch-scoped lifecycle adapter. Concurrent workers are safe: the lifecycle
 * transaction serializes on the reservation row and terminal replays are no-ops.
 */
export class PostgresInventoryReservationExpiryWorker {
  constructor(
    private readonly pool: PostgresPool,
    private readonly lifecycle: Pick<PostgresBranchInventoryReservationLifecycle, "expire">
  ) {}

  async runOnce(input: { nowUtc: string; limit?: number }): Promise<InventoryReservationExpiryBatchResult> {
    const now = Date.parse(input.nowUtc);
    const limit = input.limit ?? 50;
    if (!Number.isFinite(now) || new Date(now).toISOString() !== input.nowUtc ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("invalid_inventory_reservation_expiry_batch");
    }
    const result = await this.pool.query<{
      tenant_id: string; merchant_id: string; branch_id: string; id: string;
    }>(
      `SELECT tenant_id, merchant_id, branch_id, id
       FROM inventory_reservations
       WHERE status = 'reserved' AND expires_at IS NOT NULL AND expires_at <= $1
       ORDER BY expires_at ASC, id ASC
       LIMIT $2`,
      [input.nowUtc, limit]
    );
    const counts: InventoryReservationExpiryBatchResult = {
      selected: result.rows.length, expired: 0, alreadyFinalized: 0, notFound: 0, failed: 0
    };
    for (const row of result.rows) {
      try {
        const outcome = await this.lifecycle.expire({
          tenantId: row.tenant_id, merchantId: row.merchant_id, branchId: row.branch_id,
          reservationId: row.id, nowUtc: input.nowUtc
        });
        if (outcome.outcome === "updated") counts.expired += 1;
        else if (outcome.outcome === "already_finalized") counts.alreadyFinalized += 1;
        else counts.notFound += 1;
      } catch {
        counts.failed += 1;
      }
    }
    return counts;
  }
}
