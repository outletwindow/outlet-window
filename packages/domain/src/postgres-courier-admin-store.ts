import type { PostgresPool } from "./postgres-iam-store.js";

export type CourierAdminProfile = {
  courierId: string;
  accountStatus: "pending" | "active" | "suspended";
  verificationStatus: "pending" | "verified" | "rejected";
  maxConcurrentTasks: number;
  createdAtUtc: string;
  updatedAtUtc: string;
};

type ProfileRow = {
  courier_id: string;
  account_status: CourierAdminProfile["accountStatus"];
  verification_status: CourierAdminProfile["verificationStatus"];
  max_concurrent_tasks: number;
  created_at: Date | string;
  updated_at: Date | string;
};

const toProfile = (row: ProfileRow): CourierAdminProfile => ({
  courierId: row.courier_id,
  accountStatus: row.account_status,
  verificationStatus: row.verification_status,
  maxConcurrentTasks: row.max_concurrent_tasks,
  createdAtUtc: new Date(row.created_at).toISOString(),
  updatedAtUtc: new Date(row.updated_at).toISOString()
});

/** Platform-admin operations for controlled courier onboarding and review. */
export class PostgresCourierAdminStore {
  constructor(private readonly pool: PostgresPool, private readonly now: () => Date = () => new Date()) {}

  async listProfiles(input: { status?: "pending" | "active" | "suspended"; limit?: number } = {}): Promise<CourierAdminProfile[]> {
    const result = await this.pool.query<ProfileRow>(
      `SELECT courier_id, account_status, verification_status, max_concurrent_tasks, created_at, updated_at
       FROM courier_profiles
       WHERE ($1::text IS NULL OR account_status = $1)
       ORDER BY created_at DESC, courier_id
       LIMIT $2`,
      [input.status ?? null, input.limit ?? 100]
    );
    return result.rows.map(toProfile);
  }

  async createProfile(input: { courierId: string; maxConcurrentTasks: number }): Promise<"created" | "identity_not_found" | "identity_not_eligible" | "already_exists"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const identity = await client.query<{ id: string; principal_type: string; status: string }>(
        "SELECT id, principal_type, status FROM identities WHERE id = $1 FOR UPDATE",
        [input.courierId]
      );
      const row = identity.rows[0];
      if (!row) { await client.query("ROLLBACK"); return "identity_not_found"; }
      if (row.principal_type !== "human" || row.status !== "active") {
        await client.query("ROLLBACK"); return "identity_not_eligible";
      }
      const inserted = await client.query<{ courier_id: string }>(
        `INSERT INTO courier_profiles(courier_id, account_status, verification_status, max_concurrent_tasks, created_at, updated_at)
         VALUES ($1, 'pending', 'pending', $2, $3, $3)
         ON CONFLICT (courier_id) DO NOTHING RETURNING courier_id`,
        [input.courierId, input.maxConcurrentTasks, this.now()]
      );
      if (!inserted.rows.length) { await client.query("ROLLBACK"); return "already_exists"; }
      await client.query("COMMIT");
      return "created";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async reviewProfile(input: {
    courierId: string;
    decision: "approve" | "reject" | "suspend" | "reinstate";
    reviewerId: string;
  }): Promise<"updated" | "not_found" | "invalid_transition"> {
    const now = this.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ account_status: string; verification_status: string }>(
        "SELECT account_status, verification_status FROM courier_profiles WHERE courier_id = $1 FOR UPDATE",
        [input.courierId]
      );
      const current = selected.rows[0];
      if (!current) { await client.query("ROLLBACK"); return "not_found"; }
      let accountStatus: string;
      let verificationStatus: string;
      if (input.decision === "approve" && current.account_status === "pending" && current.verification_status === "pending") {
        accountStatus = "active"; verificationStatus = "verified";
      } else if (input.decision === "reject" && current.account_status === "pending") {
        accountStatus = "suspended"; verificationStatus = "rejected";
      } else if (input.decision === "suspend" && current.account_status === "active") {
        accountStatus = "suspended"; verificationStatus = current.verification_status;
      } else if (input.decision === "reinstate" && current.account_status === "suspended" && current.verification_status === "verified") {
        accountStatus = "active"; verificationStatus = "verified";
      } else {
        await client.query("ROLLBACK"); return "invalid_transition";
      }
      await client.query(
        `UPDATE courier_profiles
         SET account_status = $2, verification_status = $3,
             approved_by = CASE WHEN $3 = 'verified' THEN $4 ELSE approved_by END,
             approved_at = CASE WHEN $3 = 'verified' THEN $5 ELSE approved_at END,
             updated_at = $5
         WHERE courier_id = $1`,
        [input.courierId, accountStatus, verificationStatus, input.reviewerId, now]
      );
      if (accountStatus !== "active") {
        await client.query("UPDATE courier_availability SET available = false, updated_at = $2 WHERE courier_id = $1", [input.courierId, now]);
      }
      await client.query("COMMIT");
      return "updated";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
