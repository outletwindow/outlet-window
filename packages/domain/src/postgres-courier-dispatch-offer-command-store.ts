import { randomUUID } from "node:crypto";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";

export interface CourierDispatchOfferEligibility {
  /** Must query authoritative courier status, verification, service zone and capacity using this transaction client. */
  isEligible(input: {
    client: PostgresClient;
    tenantId: string;
    courierId: string;
    suborderId: string;
  }): Promise<boolean>;
}

export type CourierDispatchOfferResponse =
  | { outcome: "accepted"; taskId: string; offerVersion: number }
  | { outcome: "declined"; offerVersion: number }
  | { outcome: "not_found" | "conflict" | "expired" | "already_assigned" | "courier_ineligible" | "eligibility_unavailable" };

/**
 * Transactional offer response. An accepted delivery task is created only after
 * the offer and suborder are locked and current courier eligibility is rechecked.
 * Without an authoritative eligibility adapter, acceptance fails closed.
 */
export class PostgresCourierDispatchOfferCommandStore {
  constructor(
    private readonly pool: PostgresPool,
    private readonly eligibility?: CourierDispatchOfferEligibility,
    private readonly now: () => Date = () => new Date()
  ) {}

  async respond(input: {
    tenantId: string;
    offerId: string;
    courierId: string;
    expectedVersion: number;
    decision: "accepted" | "declined";
    reason?: string;
  }): Promise<CourierDispatchOfferResponse> {
    if (!input.tenantId.trim() || !input.offerId.trim() || !input.courierId.trim() ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
        (input.decision === "declined" && !input.reason?.trim())) {
      return { outcome: "conflict" };
    }
    if (input.decision === "accepted" && !this.eligibility) {
      return { outcome: "eligibility_unavailable" };
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{
        id: string; tenant_id: string; suborder_id: string; courier_id: string;
        status: string; version: number; expires_at: Date | string;
      }>(
        `SELECT o.id, o.tenant_id, o.suborder_id, o.courier_id, o.status, o.version, o.expires_at
         FROM courier_dispatch_offers o
         JOIN merchant_suborders s ON s.tenant_id = o.tenant_id AND s.id = o.suborder_id
         WHERE o.tenant_id = $1 AND o.id = $2 AND o.courier_id = $3
         FOR UPDATE OF o, s`,
        [input.tenantId, input.offerId, input.courierId]
      );
      const offer = selected.rows[0];
      if (!offer) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      if (offer.status !== "offered" || offer.version !== input.expectedVersion) {
        await client.query("ROLLBACK");
        return { outcome: "conflict" };
      }

      const now = this.now();
      if (!Number.isFinite(now.getTime())) throw new Error("invalid_dispatch_clock");
      if (new Date(offer.expires_at).getTime() <= now.getTime()) {
        const expiredVersion = offer.version + 1;
        await client.query(
          `UPDATE courier_dispatch_offers
           SET status = 'expired', version = $4, responded_at = $5, updated_at = $5
           WHERE tenant_id = $1 AND id = $2 AND version = $3`,
          [input.tenantId, input.offerId, input.expectedVersion, expiredVersion, now]
        );
        await this.appendEvent(client, input.tenantId, input.offerId, "offered", "expired", "system", "system", null, now);
        await client.query("COMMIT");
        return { outcome: "expired" };
      }

      if (input.decision === "declined") {
        const version = offer.version + 1;
        const reason = input.reason!.trim();
        await client.query(
          `UPDATE courier_dispatch_offers
           SET status = 'declined', version = $4, responded_at = $5,
               terminal_reason = $6, updated_at = $5
           WHERE tenant_id = $1 AND id = $2 AND version = $3`,
          [input.tenantId, input.offerId, input.expectedVersion, version, now, reason]
        );
        await this.appendEvent(client, input.tenantId, input.offerId, "offered", "declined", input.courierId, "courier", reason, now);
        await client.query("COMMIT");
        return { outcome: "declined", offerVersion: version };
      }

      const eligible = await this.eligibility!.isEligible({
        client, tenantId: input.tenantId, courierId: input.courierId, suborderId: offer.suborder_id
      });
      if (!eligible) {
        await client.query("ROLLBACK");
        return { outcome: "courier_ineligible" };
      }

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM courier_delivery_tasks
         WHERE tenant_id = $1 AND suborder_id = $2
           AND status NOT IN ('declined','cancelled','failed')
         FOR UPDATE`,
        [input.tenantId, offer.suborder_id]
      );
      if (existing.rows.length) {
        await client.query("ROLLBACK");
        return { outcome: "already_assigned" };
      }

      const taskId = randomUUID();
      await client.query(
        `INSERT INTO courier_delivery_tasks
          (id, tenant_id, suborder_id, courier_id, status, version, idempotency_key, offered_at, accepted_at)
         VALUES ($1,$2,$3,$4,'accepted',1,$5,$6,$6)`,
        [taskId, input.tenantId, offer.suborder_id, input.courierId, `dispatch-offer:${input.offerId}`, now]
      );
      await client.query(
        `INSERT INTO courier_delivery_task_events
          (id, tenant_id, task_id, sequence, from_status, to_status, actor_id, actor_role, occurred_at)
         VALUES ($1,$2,$3,1,'offered','accepted',$4,'courier',$5)`,
        [randomUUID(), input.tenantId, taskId, input.courierId, now]
      );
      const version = offer.version + 1;
      const updated = await client.query(
        `UPDATE courier_dispatch_offers
         SET status = 'accepted', version = $4, responded_at = $5,
             accepted_task_id = $6, updated_at = $5
         WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'offered'`,
        [input.tenantId, input.offerId, input.expectedVersion, version, now, taskId]
      );
      if (updated.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { outcome: "conflict" };
      }
      await this.appendEvent(client, input.tenantId, input.offerId, "offered", "accepted", input.courierId, "courier", null, now);
      await client.query("COMMIT");
      return { outcome: "accepted", taskId, offerVersion: version };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async appendEvent(
    client: PostgresClient, tenantId: string, offerId: string,
    fromStatus: string, toStatus: string, actorId: string,
    actorRole: "courier" | "system", reason: string | null, occurredAt: Date
  ): Promise<void> {
    const sequence = await client.query<{ next_sequence: number }>(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM courier_dispatch_offer_events WHERE tenant_id = $1 AND offer_id = $2`,
      [tenantId, offerId]
    );
    await client.query(
      `INSERT INTO courier_dispatch_offer_events
        (id, tenant_id, offer_id, sequence, from_status, to_status, actor_id, actor_role, reason, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [randomUUID(), tenantId, offerId, sequence.rows[0]?.next_sequence ?? 1,
        fromStatus, toStatus, actorId, actorRole, reason, occurredAt]
    );
  }
}
