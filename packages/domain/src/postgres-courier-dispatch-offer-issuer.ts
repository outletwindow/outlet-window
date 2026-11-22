import { randomUUID } from "node:crypto";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";
import type { CourierDispatchOfferEligibility } from "./postgres-courier-dispatch-offer-command-store.js";

export interface CourierDispatchOfferIssueResult {
  created: Array<{ offerId: string; courierId: string }>;
  skipped: Array<{ courierId: string; reason: "ineligible" | "already_offered" }>;
}

/**
 * Persists a bounded shortlist of courier offers for a pickup-ready suborder.
 * Eligibility is checked again for each candidate inside the same transaction;
 * offer acceptance performs its own fresh transactional check as well.
 */
export class PostgresCourierDispatchOfferIssuer {
  constructor(
    private readonly pool: PostgresPool,
    private readonly eligibility: CourierDispatchOfferEligibility,
    private readonly now: () => Date = () => new Date()
  ) {}

  async issue(input: {
    tenantId: string;
    suborderId: string;
    courierIds: readonly string[];
    expiresAtUtc: string;
    dispatcherId: string;
  }): Promise<CourierDispatchOfferIssueResult> {
    const now = this.now();
    const expiresAt = Date.parse(input.expiresAtUtc);
    // A stable lock order prevents concurrent dispatch batches from deadlocking when they overlap couriers.\n    const ids = [...input.courierIds].sort((left, right) => left.localeCompare(right));
    if (!input.tenantId.trim() || !input.suborderId.trim() || !input.dispatcherId.trim() ||
        !Number.isFinite(now.getTime()) || !Number.isFinite(expiresAt) ||
        expiresAt <= now.getTime() || expiresAt - now.getTime() > 15 * 60_000 ||
        ids.length < 1 || ids.length > 100 ||
        ids.some(id => !id.trim() || id.length > 200) ||
        new Set(ids).size !== ids.length) {
      throw new Error("invalid_courier_dispatch_offer_issue");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const suborder = await client.query<{ status: string }>(
        `SELECT status FROM merchant_suborders
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [input.tenantId, input.suborderId]
      );
      if (!suborder.rowCount || suborder.rows[0]?.status !== "ready_for_pickup") {
        await client.query("ROLLBACK");
        throw new Error("courier_dispatch_suborder_not_ready");
      }

      const assigned = await client.query<{ id: string }>(
        `SELECT id FROM courier_delivery_tasks
         WHERE tenant_id = $1 AND suborder_id = $2
           AND status NOT IN ('declined','cancelled','failed')
         LIMIT 1 FOR UPDATE`,
        [input.tenantId, input.suborderId]
      );
      if (assigned.rowCount) {
        await client.query("ROLLBACK");
        throw new Error("courier_dispatch_suborder_already_assigned");
      }

      const created: CourierDispatchOfferIssueResult["created"] = [];
      const skipped: CourierDispatchOfferIssueResult["skipped"] = [];
      for (const courierId of ids) {
        const eligible = await this.eligibility.isEligible({
          client, tenantId: input.tenantId, courierId, suborderId: input.suborderId
        });
        if (!eligible) {
          skipped.push({ courierId, reason: "ineligible" });
          continue;
        }
        const offerId = randomUUID();
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO courier_dispatch_offers
            (id, tenant_id, suborder_id, courier_id, status, version, offered_at, expires_at)
           VALUES ($1,$2,$3,$4,'offered',1,$5,$6)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [offerId, input.tenantId, input.suborderId, courierId, now, new Date(expiresAt).toISOString()]
        );
        if (inserted.rowCount !== 1) {
          skipped.push({ courierId, reason: "already_offered" });
          continue;
        }
        await client.query(
          `INSERT INTO courier_dispatch_offer_events
            (id, tenant_id, offer_id, sequence, from_status, to_status, actor_id, actor_role, occurred_at)
           VALUES ($1,$2,$3,1,NULL,'offered',$4,'dispatcher',$5)`,
          [randomUUID(), input.tenantId, offerId, input.dispatcherId, now]
        );
        created.push({ offerId, courierId });
      }
      await client.query("COMMIT");
      return { created, skipped };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
