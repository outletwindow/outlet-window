import { createHash, randomUUID } from "node:crypto";
import type { PostgresQueryable } from "./postgres-iam-store.js";
import type {
  IntegrationEvent, IntegrationRegistration, IntegrationRegistryStore
} from "./integration-hub.js";

type IntegrationRow = {
  id: string; tenant_id: string; family: IntegrationRegistration["family"];
  provider_key: string; display_name: string; status: IntegrationRegistration["status"];
  secret_reference: string | null; capabilities: string[] | string;
  created_at: Date | string; updated_at: Date | string;
};
const iso = (value: Date | string) => new Date(value).toISOString();

function fromRow(row: IntegrationRow): IntegrationRegistration {
  const capabilities = typeof row.capabilities === "string"
    ? JSON.parse(row.capabilities) as string[]
    : row.capabilities;
  return {
    id: row.id, tenantId: row.tenant_id, family: row.family,
    providerKey: row.provider_key, displayName: row.display_name,
    status: row.status,
    ...(row.secret_reference === null ? {} : { secretReference: row.secret_reference }),
    capabilities, createdAtUtc: iso(row.created_at), updatedAtUtc: iso(row.updated_at)
  };
}

/** PostgreSQL-backed tenant-isolated integration registry and durable event inbox. */
export class PostgresIntegrationRegistryStore implements IntegrationRegistryStore {
  constructor(private readonly db: PostgresQueryable) {}

  async get(tenantId: string, integrationId: string): Promise<IntegrationRegistration | null> {
    const result = await this.db.query<IntegrationRow>(
      "SELECT * FROM tenant_integrations WHERE tenant_id = $1 AND id = $2",
      [tenantId, integrationId]
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async list(tenantId: string, family?: IntegrationRegistration["family"]): Promise<IntegrationRegistration[]> {
    const result = await this.db.query<IntegrationRow>(
      `SELECT * FROM tenant_integrations
       WHERE tenant_id = $1 AND ($2::text IS NULL OR family = $2)
       ORDER BY family, display_name, id`,
      [tenantId, family ?? null]
    );
    return result.rows.map(fromRow);
  }

  async put(registration: IntegrationRegistration): Promise<void> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO tenant_integrations
       (id, tenant_id, family, provider_key, display_name, status, secret_reference,
        capabilities, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       ON CONFLICT (tenant_id, id) DO NOTHING
       RETURNING id`,
      [registration.id, registration.tenantId, registration.family, registration.providerKey,
        registration.displayName, registration.status, registration.secretReference ?? null,
        JSON.stringify([...new Set(registration.capabilities)]),
        registration.createdAtUtc, registration.updatedAtUtc]
    );
    if (result.rowCount !== 1) throw new Error("INTEGRATION_ALREADY_EXISTS");
  }

  async updateSecretReference(
    tenantId: string,
    integrationId: string,
    secretReference: string,
    updatedAtUtc: string
  ): Promise<"updated" | "not_found"> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE tenant_integrations
       SET secret_reference = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2
       RETURNING id`,
      [tenantId, integrationId, secretReference, updatedAtUtc]
    );
    return result.rowCount === 1 ? "updated" : "not_found";
  }

  async updateStatus(
    tenantId: string,
    integrationId: string,
    expectedStatus: IntegrationRegistration["status"],
    nextStatus: IntegrationRegistration["status"],
    updatedAtUtc: string
  ): Promise<"updated" | "conflict"> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE tenant_integrations
       SET status = $4, updated_at = $5
       WHERE tenant_id = $1 AND id = $2 AND status = $3 AND updated_at <= $5
       RETURNING id`,
      [tenantId, integrationId, expectedStatus, nextStatus, updatedAtUtc]
    );
    return result.rowCount === 1 ? "updated" : "conflict";
  }

  async recordEvent(event: IntegrationEvent): Promise<"inserted" | "duplicate"> {
    if (typeof event.payload !== "object" || event.payload === null) {
      throw new Error("INVALID_INTEGRATION_EVENT_PAYLOAD");
    }
    const payload = JSON.stringify(event.payload);
    const digest = createHash("sha256").update(payload).digest("hex");
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO integration_event_inbox
       (id, tenant_id, integration_id, provider_event_id, event_type, idempotency_key,
        occurred_at, status, payload, payload_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'received',$8::jsonb,$9)
       ON CONFLICT DO NOTHING RETURNING id`,
      [randomUUID(), event.tenantId, event.integrationId, event.providerEventId,
        event.eventType, event.idempotencyKey, event.occurredAtUtc, payload, digest]
    );
    return result.rowCount === 1 ? "inserted" : "duplicate";
  }
}
