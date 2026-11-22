import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";
import {
  transitionCourierTask,
  type CourierTask,
  type CourierTaskStatus
} from "./courier-task.js";

type TaskRow = {
  id: string; tenant_id: string; order_id: string; suborder_id: string;
  courier_id: string; status: CourierTaskStatus; version: number; updated_at: Date | string;
};

const toTask = (row: TaskRow): CourierTask => ({
  id: row.id, tenantId: row.tenant_id, orderId: row.order_id,
  suborderId: row.suborder_id, courierId: row.courier_id,
  status: row.status, version: row.version,
  updatedAtUtc: new Date(row.updated_at).toISOString()
});

export type CourierTaskTransitionOutcome =
  | { outcome: "updated"; task: CourierTask }
  | { outcome: "not_found" | "conflict" | "rejected"; reason?: string };

/**
 * PostgreSQL courier-task repository.
 * Tenant/courier identifiers must come from the authenticated actor and trusted
 * assignment context, never from an untrusted request body.
 */
export class PostgresCourierTaskStore {
  constructor(
    private readonly pool: PostgresPool,
    private readonly digestPickupCode: (code: string) => Promise<string>,
    private readonly now: () => Date = () => new Date()
  ) {}

  async listForCourier(input: {
    tenantId: string;
    courierId: string;
    statuses?: readonly CourierTaskStatus[];
    limit?: number;
  }): Promise<CourierTask[]> {
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
    const result = await this.pool.query<TaskRow>(
      `SELECT t.id, t.tenant_id, s.order_id, t.suborder_id, t.courier_id,
              t.status, t.version, t.updated_at
       FROM courier_delivery_tasks t
       JOIN merchant_suborders s
         ON s.tenant_id = t.tenant_id AND s.id = t.suborder_id
       WHERE t.tenant_id = $1 AND t.courier_id = $2
         AND ($3::text[] IS NULL OR t.status = ANY($3::text[]))
       ORDER BY t.offered_at DESC
       LIMIT $4`,
      [input.tenantId, input.courierId, input.statuses?.length ? input.statuses : null, limit]
    );
    return result.rows.map(toTask);
  }

  async transition(input: {
    tenantId: string;
    taskId: string;
    courierId: string;
    nextStatus: CourierTaskStatus;
    expectedVersion: number;
    pickupCode?: string;
    reason?: string;
  }): Promise<CourierTaskTransitionOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<TaskRow>(
        `SELECT t.id, t.tenant_id, s.order_id, t.suborder_id, t.courier_id,
                t.status, t.version, t.updated_at
         FROM courier_delivery_tasks t
         JOIN merchant_suborders s
           ON s.tenant_id = t.tenant_id AND s.id = t.suborder_id
         WHERE t.tenant_id = $1 AND t.id = $2 AND t.courier_id = $3
         FOR UPDATE OF t`,
        [input.tenantId, input.taskId, input.courierId]
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }

      let pickupCodeVerified = false;
      if (input.nextStatus === "picked_up" && typeof input.pickupCode === "string") {
        const digest = await this.digestPickupCode(input.pickupCode);
        if (digest.length >= 32 && digest.length <= 256) {
          const credential = await client.query<{ id: string }>(
            `UPDATE courier_pickup_code_credentials
             SET consumed_at = clock_timestamp()
             WHERE tenant_id = $1 AND task_id = $2 AND code_digest = $3
               AND consumed_at IS NULL AND revoked_at IS NULL
               AND expires_at > clock_timestamp() AND failed_attempts < max_attempts
             RETURNING id`,
            [input.tenantId, input.taskId, digest]
          );
          pickupCodeVerified = credential.rowCount === 1;
          if (!pickupCodeVerified) {
            await client.query(
              `UPDATE courier_pickup_code_credentials
               SET failed_attempts = failed_attempts + 1
               WHERE tenant_id = $1 AND task_id = $2
                 AND consumed_at IS NULL AND revoked_at IS NULL
                 AND expires_at > clock_timestamp() AND failed_attempts < max_attempts`,
              [input.tenantId, input.taskId]
            );
          }
        }
      }

      let deliveryProofVerified = false;
      if (input.nextStatus === "delivered") {
        const proof = await client.query<{ id: string }>(
          `SELECT id FROM courier_delivery_evidence
           WHERE tenant_id = $1 AND task_id = $2
             AND evidence_type = 'proof_of_delivery'
             AND object_key IS NOT NULL AND content_sha256 IS NOT NULL
           ORDER BY verified_at DESC LIMIT 1`,
          [input.tenantId, input.taskId]
        );
        deliveryProofVerified = proof.rows.length > 0;
      }

      const occurredAtUtc = this.now().toISOString();
      const transition = transitionCourierTask(toTask(row), input.nextStatus, {
        actorId: input.courierId,
        actorRole: "courier",
        expectedVersion: input.expectedVersion,
        occurredAtUtc,
        pickupCodeVerified,
        deliveryProofVerified,
        ...(input.reason === undefined ? {} : { reason: input.reason })
      });
      if (!transition.ok) {
        // Persist failed pickup attempts. Rolling back here would silently reset the
        // failed_attempts counter and disable the credential's brute-force limit.
        if (transition.reason === "pickup_code_not_verified") {
          await client.query("COMMIT");
          return { outcome: "rejected", reason: transition.reason };
        }
        await client.query("ROLLBACK");
        return { outcome: transition.reason === "version_conflict" ? "conflict" : "rejected", reason: transition.reason };
      }

      const updated = await client.query(
        `UPDATE courier_delivery_tasks
         SET status = $4, version = version + 1, updated_at = $5,
             accepted_at = CASE WHEN $4 = 'accepted' THEN $5 ELSE accepted_at END,
             picked_up_at = CASE WHEN $4 = 'picked_up' THEN $5 ELSE picked_up_at END,
             delivered_at = CASE WHEN $4 = 'delivered' THEN $5 ELSE delivered_at END,
             terminal_reason = CASE WHEN $4 IN ('declined','cancelled','failed') THEN $6 ELSE terminal_reason END
         WHERE tenant_id = $1 AND id = $2 AND courier_id = $3 AND version = $7`,
        [input.tenantId, input.taskId, input.courierId, input.nextStatus,
          occurredAtUtc, input.reason ?? null, input.expectedVersion]
      );
      if (updated.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { outcome: "conflict" };
      }

      await client.query(
        `INSERT INTO courier_delivery_task_events
          (id, tenant_id, task_id, sequence, from_status, to_status, actor_id, actor_role, reason, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'courier',$8,$9)`,
        [randomUUID(), input.tenantId, input.taskId,
          transition.task.version, row.status, input.nextStatus, input.courierId,
          input.reason ?? null, occurredAtUtc]
      );

      if (input.nextStatus === "picked_up") {
        await client.query(
          `INSERT INTO courier_delivery_evidence
            (id, tenant_id, task_id, evidence_type, verification_method, verified_by, verified_at)
           VALUES ($1,$2,$3,'pickup_code_verification','server_digest_match',$4,$5)`,
          [randomUUID(), input.tenantId, input.taskId,
            input.courierId, occurredAtUtc]
        );
      }

      await client.query("COMMIT");
      return { outcome: "updated", task: transition.task };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
