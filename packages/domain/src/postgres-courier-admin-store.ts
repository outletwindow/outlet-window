import type { PostgresPool } from "./postgres-iam-store.js";

export type CourierAdminVehicle = {
  vehicleId: string; courierId: string; vehicleType: "motorcycle" | "car" | "van";
  verificationStatus: "pending" | "verified" | "rejected"; capacityWeightGrams: number;
  capacityVolumeLiters: number; active: boolean; createdAtUtc: string; updatedAtUtc: string;
};

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

  async listVehicles(input: { status?: "pending" | "verified" | "rejected"; limit?: number } = {}): Promise<CourierAdminVehicle[]> {
    const result = await this.pool.query<{
      id: string; courier_id: string; vehicle_type: CourierAdminVehicle["vehicleType"];
      verification_status: CourierAdminVehicle["verificationStatus"]; capacity_weight_grams: number;
      capacity_volume_liters: number; active: boolean; created_at: Date | string; updated_at: Date | string;
    }>(
      `SELECT id, courier_id, vehicle_type, verification_status, capacity_weight_grams,
              capacity_volume_liters, active, created_at, updated_at
       FROM courier_vehicles
       WHERE ($1::text IS NULL OR verification_status = $1)
       ORDER BY created_at DESC, id
       LIMIT $2`,
      [input.status ?? null, input.limit ?? 100]
    );
    return result.rows.map(row => ({
      vehicleId: row.id, courierId: row.courier_id, vehicleType: row.vehicle_type,
      verificationStatus: row.verification_status, capacityWeightGrams: row.capacity_weight_grams,
      capacityVolumeLiters: row.capacity_volume_liters, active: row.active,
      createdAtUtc: new Date(row.created_at).toISOString(), updatedAtUtc: new Date(row.updated_at).toISOString()
    }));
  }

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

  async registerVehicle(input: {
    vehicleId: string; courierId: string; vehicleType: "motorcycle" | "car" | "van";
    capacityWeightGrams: number; capacityVolumeLiters: number;
  }): Promise<"created" | "courier_not_found" | "courier_not_active" | "already_exists"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const profile = await client.query<{ account_status: string; verification_status: string }>(
        "SELECT account_status, verification_status FROM courier_profiles WHERE courier_id = $1 FOR UPDATE",
        [input.courierId]
      );
      const row = profile.rows[0];
      if (!row) { await client.query("ROLLBACK"); return "courier_not_found"; }
      if (row.account_status !== "active" || row.verification_status !== "verified") {
        await client.query("ROLLBACK"); return "courier_not_active";
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO courier_vehicles
          (id, courier_id, vehicle_type, verification_status, capacity_weight_grams, capacity_volume_liters, active, created_at, updated_at)
         VALUES ($1,$2,$3,'pending',$4,$5,false,$6,$6)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [input.vehicleId, input.courierId, input.vehicleType, input.capacityWeightGrams, input.capacityVolumeLiters, this.now()]
      );
      if (!inserted.rows.length) { await client.query("ROLLBACK"); return "already_exists"; }
      await client.query("COMMIT");
      return "created";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async reviewVehicle(input: {
    vehicleId: string; decision: "approve" | "reject"; reviewerId: string;
  }): Promise<"updated" | "not_found" | "invalid_transition"> {
    const client = await this.pool.connect();
    const now = this.now();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ verification_status: string; courier_id: string }>(
        "SELECT verification_status, courier_id FROM courier_vehicles WHERE id = $1 FOR UPDATE",
        [input.vehicleId]
      );
      const row = selected.rows[0];
      if (!row) { await client.query("ROLLBACK"); return "not_found"; }
      if (row.verification_status !== "pending") { await client.query("ROLLBACK"); return "invalid_transition"; }
      const verified = input.decision === "approve";
      await client.query(
        `UPDATE courier_vehicles SET verification_status = $2, active = $3,
          verified_by = CASE WHEN $3 THEN $4 ELSE verified_by END,
          verified_at = CASE WHEN $3 THEN $5 ELSE verified_at END, updated_at = $5 WHERE id = $1`,
        [input.vehicleId, verified ? "verified" : "rejected", verified, input.reviewerId, now]
      );
      if (!verified) {
        await client.query("UPDATE courier_availability SET available = false, updated_at = $2 WHERE courier_id = $1", [row.courier_id, now]);
      }
      await client.query("COMMIT");
      return "updated";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async grantServiceArea(input: {
    courierId: string; tenantId: string; serviceAreaId: string; reviewerId: string;
  }): Promise<"granted" | "courier_not_found" | "courier_not_active" | "service_area_not_active"> {
    const client = await this.pool.connect();
    const now = this.now();
    try {
      await client.query("BEGIN");
      const profile = await client.query<{ account_status: string; verification_status: string }>(
        "SELECT account_status, verification_status FROM courier_profiles WHERE courier_id = $1 FOR UPDATE",
        [input.courierId]
      );
      const row = profile.rows[0];
      if (!row) { await client.query("ROLLBACK"); return "courier_not_found"; }
      if (row.account_status !== "active" || row.verification_status !== "verified") {
        await client.query("ROLLBACK"); return "courier_not_active";
      }
      const area = await client.query<{ id: string }>(
        `SELECT id FROM delivery_service_areas
         WHERE tenant_id = $1 AND id = $2 AND status = 'active'
           AND effective_from <= $3 AND (effective_until IS NULL OR effective_until > $3)
         FOR SHARE`,
        [input.tenantId, input.serviceAreaId, now]
      );
      if (!area.rows.length) { await client.query("ROLLBACK"); return "service_area_not_active"; }
      await client.query(
        `INSERT INTO courier_service_area_memberships
          (courier_id, tenant_id, service_area_id, active, approved_by, approved_at, created_at)
         VALUES ($1,$2,$3,true,$4,$5,$5)
         ON CONFLICT (courier_id, tenant_id, service_area_id)
         DO UPDATE SET active = true, approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at`,
        [input.courierId, input.tenantId, input.serviceAreaId, input.reviewerId, now]
      );
      await client.query("COMMIT");
      return "granted";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async revokeServiceArea(input: {
    courierId: string; tenantId: string; serviceAreaId: string;
  }): Promise<"revoked" | "not_found"> {
    const result = await this.pool.query(
      `UPDATE courier_service_area_memberships SET active = false
       WHERE courier_id = $1 AND tenant_id = $2 AND service_area_id = $3 AND active = true`,
      [input.courierId, input.tenantId, input.serviceAreaId]
    );
    return (result.rowCount ?? 0) > 0 ? "revoked" : "not_found";
  }

}
