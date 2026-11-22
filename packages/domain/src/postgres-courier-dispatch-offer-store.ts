import type { PostgresPool } from "./postgres-iam-store.js";

export interface CourierDispatchOfferSummary {
  id: string;
  suborderId: string;
  status: "offered";
  version: number;
  offeredAtUtc: string;
  expiresAtUtc: string;
}

/**
 * Read-only courier inbox for durable dispatch offers.
 * Acceptance and assignment are deliberately handled by a separate transactional
 * command so the inbox can never imply that an offer is already a delivery task.
 */
export class PostgresCourierDispatchOfferStore {
  constructor(
    private readonly pool: PostgresPool,
    private readonly now: () => Date = () => new Date()
  ) {}

  async listForCourier(input: {
    tenantId: string;
    courierId: string;
    limit?: number;
  }): Promise<CourierDispatchOfferSummary[]> {
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
    const result = await this.pool.query<{
      id: string; suborder_id: string; status: "offered"; version: number;
      offered_at: Date | string; expires_at: Date | string;
    }>(
      `SELECT id, suborder_id, status, version, offered_at, expires_at
       FROM courier_dispatch_offers
       WHERE tenant_id = $1 AND courier_id = $2
         AND status = 'offered' AND expires_at > $3
       ORDER BY offered_at DESC, id ASC
       LIMIT $4`,
      [input.tenantId, input.courierId, this.now(), limit]
    );
    return result.rows.map(row => ({
      id: row.id,
      suborderId: row.suborder_id,
      status: row.status,
      version: row.version,
      offeredAtUtc: new Date(row.offered_at).toISOString(),
      expiresAtUtc: new Date(row.expires_at).toISOString()
    }));
  }
}
