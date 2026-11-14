import type { AuditEvent } from "./audit.js";
import type { PostgresQueryable } from "./postgres-iam-store.js";

export interface AuditEventReader {
  list(input: { tenantId: string; limit: number; before?: string }): Promise<readonly AuditEvent[]>;
}

/** Append-only PostgreSQL audit persistence. Reads are always tenant-scoped. */
export class PostgresAuditEventStore implements AuditEventReader {
  constructor(private readonly database: PostgresQueryable) {}

  async append(event: AuditEvent): Promise<"inserted" | "already_exists"> {
    const result = await this.database.query(
      `INSERT INTO audit_events (
        id, schema_version, event_type, category, occurred_at, actor_id, actor_type, actor_role,
        action, outcome, resource_type, resource_id, tenant_id, merchant_id, branch_id,
        correlation_id, request_id, source, severity, approval_id, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
      ON CONFLICT (id) DO NOTHING RETURNING id`,
      [event.id, event.schemaVersion, event.type, event.category, event.occurredAt,
        event.actor.id, event.actor.type, event.actor.role ?? null, event.action, event.outcome,
        event.resourceType ?? null, event.resourceId ?? null, event.tenantId ?? null,
        event.merchantId ?? null, event.branchId ?? null, event.correlationId,
        event.requestId ?? null, event.source, event.severity, event.approvalId ?? null,
        JSON.stringify(event.metadata)]
    );
    return result.rowCount === 1 ? "inserted" : "already_exists";
  }

  async list(input: { tenantId: string; limit: number; before?: string }): Promise<readonly AuditEvent[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new RangeError("Audit page limit must be between 1 and 200");
    }
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM audit_events WHERE tenant_id = $1
       AND ($2::timestamptz IS NULL OR occurred_at < $2)
       ORDER BY occurred_at DESC, id DESC LIMIT $3`,
      [input.tenantId, input.before ?? null, input.limit]
    );
    return result.rows.map(row => ({
      id: String(row.id), schemaVersion: 1, type: String(row.event_type),
      category: String(row.category), occurredAt: new Date(String(row.occurred_at)).toISOString(),
      actor: { id: String(row.actor_id), type: row.actor_type as AuditEvent["actor"]["type"],
        ...(row.actor_role == null ? {} : { role: String(row.actor_role) }) },
      action: String(row.action), outcome: row.outcome as AuditEvent["outcome"],
      ...(row.resource_type == null ? {} : { resourceType: String(row.resource_type) }),
      ...(row.resource_id == null ? {} : { resourceId: String(row.resource_id) }),
      ...(row.tenant_id == null ? {} : { tenantId: String(row.tenant_id) }),
      ...(row.merchant_id == null ? {} : { merchantId: String(row.merchant_id) }),
      ...(row.branch_id == null ? {} : { branchId: String(row.branch_id) }),
      correlationId: String(row.correlation_id),
      ...(row.request_id == null ? {} : { requestId: String(row.request_id) }),
      source: String(row.source), severity: row.severity as AuditEvent["severity"],
      ...(row.approval_id == null ? {} : { approvalId: String(row.approval_id) }),
      metadata: row.metadata as AuditEvent["metadata"]
    }));
  }
}
