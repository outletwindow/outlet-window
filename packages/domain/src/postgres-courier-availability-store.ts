import type { PostgresPool } from "./postgres-iam-store.js";

export type CourierAvailabilityUpdate =
  | { outcome: "updated"; available: boolean; updatedAtUtc: string }
  | { outcome: "not_found" | "not_eligible" };

/** Persists the courier's explicit online/offline state and heartbeat. */
export class PostgresCourierAvailabilityStore {
  constructor(private readonly pool: PostgresPool, private readonly now: () => Date = () => new Date()) {}

  async setAvailability(input: { courierId: string; available: boolean }): Promise<CourierAvailabilityUpdate> {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error("invalid_courier_availability_clock");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const profile = await client.query<{ account_status: string; verification_status: string }>(
        `SELECT p.account_status, p.verification_status
         FROM courier_profiles p
         JOIN identities i ON i.id = p.courier_id
         WHERE p.courier_id = $1 AND i.status = 'active'
         FOR UPDATE OF p`,
        [input.courierId]
      );
      const row = profile.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      if (input.available && (row.account_status !== "active" || row.verification_status !== "verified")) {
        await client.query("ROLLBACK");
        return { outcome: "not_eligible" };
      }
      if (input.available) {
        const vehicle = await client.query<{ id: string }>(
          `SELECT id FROM courier_vehicles
           WHERE courier_id = $1 AND active = true AND verification_status = 'verified'
           LIMIT 1`,
          [input.courierId]
        );
        if (!vehicle.rows.length) {
          await client.query("ROLLBACK");
          return { outcome: "not_eligible" };
        }
      }
      const saved = await client.query<{ updated_at: Date | string }>(
        `INSERT INTO courier_availability(courier_id, available, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (courier_id) DO UPDATE
           SET available = EXCLUDED.available, updated_at = EXCLUDED.updated_at
         RETURNING updated_at`,
        [input.courierId, input.available, now]
      );
      await client.query("COMMIT");
      const updatedAtUtc = new Date(saved.rows[0]!.updated_at).toISOString();
      return { outcome: "updated", available: input.available, updatedAtUtc };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
