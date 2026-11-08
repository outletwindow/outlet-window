import type { RecoveryRecord, RecoveryStateStore } from "./self-healing.js";
import type { PostgresPool } from "./postgres-iam-store.js";

/** Durable recovery history. Stores only validated identifiers and reason codes, never raw errors or payloads. */
export class PostgresSelfHealingStore implements RecoveryStateStore {
  constructor(private readonly pool: PostgresPool) {}

  async wasRecentlyAttempted(service: string, action: RecoveryRecord["action"], cooldownSeconds: number): Promise<boolean> {
    if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(service) ||
        !Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 1 || cooldownSeconds > 86_400) {
      throw new Error("INVALID_RECOVERY_COOLDOWN_QUERY");
    }
    const result = await this.pool.query<{ found: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM self_healing_recovery_events WHERE service=$1 AND action=$2 AND occurred_at > now()-($3 * interval '1 second')) AS found",
      [service, action, cooldownSeconds]
    );
    return result.rows[0]?.found === true;
  }

  async record(record: RecoveryRecord): Promise<void> {
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(record.incidentId) ||
        !/^[a-zA-Z0-9._:-]{1,120}$/.test(record.service) ||
        !/^[A-Z0-9_]{1,100}$/.test(record.reason)) {
      throw new Error("INVALID_RECOVERY_RECORD");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO self_healing_incidents
          (incident_id,service,severity,status,automatic_attempt_count,last_action,last_attempt_at,last_outcome,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7)
         ON CONFLICT (incident_id) DO UPDATE SET
           severity=EXCLUDED.severity,
           status=EXCLUDED.status,
           automatic_attempt_count=self_healing_incidents.automatic_attempt_count + EXCLUDED.automatic_attempt_count,
           last_action=EXCLUDED.last_action,
           last_attempt_at=EXCLUDED.last_attempt_at,
           last_outcome=EXCLUDED.last_outcome,
           updated_at=EXCLUDED.updated_at`,
        [record.incidentId, record.service, record.severity,
          record.outcome === "retry_scheduled" ? "open" : record.outcome,
          record.action === "manual_review" || record.outcome === "blocked" || record.outcome === "approval_required" ? 0 : 1,
          record.action, record.occurredAtUtc, record.outcome]
      );
      await client.query(
        "INSERT INTO self_healing_recovery_events (incident_id,service,action,outcome,reason_code,occurred_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [record.incidentId, record.service, record.action, record.outcome, record.reason, record.occurredAtUtc]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
