import { randomInt, randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

export type MerchantPickupCodeRole =
  | "merchant_employee"
  | "branch_manager"
  | "merchant_admin"
  | "merchant_owner";

export type IssueCourierPickupCodeOutcome =
  | { outcome: "issued"; code: string; expiresAtUtc: string }
  | { outcome: "not_found" | "not_ready" | "invalid_actor" | "rate_limited" };

const ALLOWED_ROLES = new Set<MerchantPickupCodeRole>([
  "merchant_employee", "branch_manager", "merchant_admin", "merchant_owner"
]);

/**
 * Issues a short-lived pickup code for a merchant-scoped courier task.
 * The caller must perform the HTTP permission check before calling this store.
 * This repository independently verifies every tenant/order/merchant/branch link.
 */
export class PostgresCourierPickupCodeIssuer {
  constructor(
    private readonly pool: PostgresPool,
    private readonly digestCode: (code: string) => Promise<string>,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMilliseconds = 15 * 60 * 1000
  ) {
    if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds < 60_000 || ttlMilliseconds > 60 * 60 * 1000) {
      throw new TypeError("invalid_pickup_code_ttl");
    }
  }

  async issue(input: {
    tenantId: string;
    merchantId: string;
    branchId: string;
    orderId: string;
    suborderId: string;
    taskId: string;
    actorId: string;
    actorRole: MerchantPickupCodeRole;
  }): Promise<IssueCourierPickupCodeOutcome> {
    if (!ALLOWED_ROLES.has(input.actorRole) || !input.actorId.trim()) {
      return { outcome: "invalid_actor" };
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{
        task_id: string;
        task_status: string;
        suborder_status: string;
      }>(
        `SELECT t.id AS task_id, t.status AS task_status, s.status AS suborder_status
         FROM courier_delivery_tasks t
         JOIN merchant_suborders s
           ON s.tenant_id = t.tenant_id AND s.id = t.suborder_id
         WHERE t.tenant_id = $1 AND t.id = $2 AND t.suborder_id = $3
           AND s.order_id = $4 AND s.merchant_id = $5 AND s.branch_id = $6
         FOR UPDATE OF t, s`,
        [input.tenantId, input.taskId, input.suborderId, input.orderId, input.merchantId, input.branchId]
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      if (row.suborder_status !== "ready_for_pickup" ||
          !["accepted", "heading_to_pickup", "arrived_at_pickup"].includes(row.task_status)) {
        await client.query("ROLLBACK");
        return { outcome: "not_ready" };
      }

      const occurredAt = this.now();
      if (!Number.isFinite(occurredAt.getTime())) throw new Error("invalid_clock");
      const throttle = await client.query<{ issue_count: number; blocked_until: Date | string | null }>(
        `INSERT INTO courier_pickup_code_issue_limits
          (tenant_id, task_id, actor_id, window_started_at, issue_count, updated_at)
         VALUES ($1,$2,$3,$4,1,$4)
         ON CONFLICT (tenant_id, task_id, actor_id) DO UPDATE
         SET window_started_at = CASE
               WHEN courier_pickup_code_issue_limits.window_started_at <= $4::timestamptz - interval '15 minutes'
               THEN $4 ELSE courier_pickup_code_issue_limits.window_started_at END,
             issue_count = CASE
               WHEN courier_pickup_code_issue_limits.window_started_at <= $4::timestamptz - interval '15 minutes'
               THEN 1 ELSE courier_pickup_code_issue_limits.issue_count + 1 END,
             blocked_until = CASE
               WHEN courier_pickup_code_issue_limits.blocked_until > $4 THEN courier_pickup_code_issue_limits.blocked_until
               WHEN courier_pickup_code_issue_limits.window_started_at <= $4::timestamptz - interval '15 minutes'
               THEN NULL
               WHEN courier_pickup_code_issue_limits.issue_count >= 3
               THEN $4::timestamptz + interval '15 minutes'
               ELSE NULL END,
             updated_at = $4
         RETURNING issue_count, blocked_until`,
        [input.tenantId, input.taskId, input.actorId, occurredAt.toISOString()]
      );
      const throttleRow = throttle.rows[0];
      if (!throttleRow) throw new Error("pickup_code_throttle_unavailable");
      if (throttleRow.issue_count > 3 ||
          (throttleRow.blocked_until !== null && new Date(throttleRow.blocked_until).getTime() > occurredAt.getTime())) {
        await client.query("COMMIT");
        return { outcome: "rate_limited" };
      }

      const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
      const digest = await this.digestCode(code);
      if (typeof digest !== "string" || !/^[a-f0-9]{64,256}$/i.test(digest)) {
        throw new Error("invalid_pickup_code_digest");
      }
      const expiresAt = new Date(occurredAt.getTime() + this.ttlMilliseconds);
      const revoked = await client.query<{ id: string }>(
        `UPDATE courier_pickup_code_credentials
         SET revoked_at = $3
         WHERE tenant_id = $1 AND task_id = $2
           AND consumed_at IS NULL AND revoked_at IS NULL
         RETURNING id`,
        [input.tenantId, input.taskId, occurredAt.toISOString()]
      );
      const credentialId = randomUUID();
      await client.query(
        `INSERT INTO courier_pickup_code_credentials
          (id, tenant_id, task_id, code_digest, expires_at, max_attempts, created_at)
         VALUES ($1,$2,$3,$4,$5,5,$6)`,
        [credentialId, input.tenantId, input.taskId, digest, expiresAt.toISOString(), occurredAt.toISOString()]
      );
      await client.query(
        `INSERT INTO courier_pickup_code_issuance_audit
          (id, tenant_id, task_id, credential_id, merchant_id, branch_id, order_id,
           suborder_id, actor_id, actor_role, action, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [randomUUID(), input.tenantId, input.taskId, credentialId, input.merchantId,
          input.branchId, input.orderId, input.suborderId, input.actorId, input.actorRole,
          revoked.rows.length ? "reissued" : "issued", occurredAt.toISOString()]
      );
      await client.query("COMMIT");
      // Plaintext exists only in this one-time return value; never persist or log it.
      return { outcome: "issued", code, expiresAtUtc: expiresAt.toISOString() };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
