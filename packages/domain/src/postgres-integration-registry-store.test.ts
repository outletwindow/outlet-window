import { describe, expect, it, vi } from "vitest";
import type { PostgresQueryable, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresIntegrationRegistryStore } from "./postgres-integration-registry-store.js";
import type { IntegrationEvent, IntegrationRegistration } from "./integration-hub.js";

function database(result: PostgresQueryResult<unknown> = { rows: [], rowCount: 0 }) {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => result);
  return { query, client: { query } as unknown as PostgresQueryable };
}

const registration: IntegrationRegistration = {
  id: "pos-main",
  tenantId: "tenant-a",
  family: "pos",
  providerKey: "generic-pos",
  displayName: "Main branch POS",
  status: "connected",
  secretReference: "vault://tenant-a/pos-main",
  capabilities: ["catalog.read", "inventory.read"],
  createdAtUtc: "2026-11-08T10:00:00.000Z",
  updatedAtUtc: "2026-11-08T10:00:00.000Z"
};

const event: IntegrationEvent = {
  tenantId: "tenant-a",
  integrationId: "pos-main",
  providerEventId: "evt-1",
  eventType: "inventory.updated",
  occurredAtUtc: "2026-11-08T10:01:00.000Z",
  idempotencyKey: "tenant-a:pos-main:evt-1",
  payload: { sku: "SKU-1", quantity: 4 }
};

describe("PostgresIntegrationRegistryStore", () => {
  it("scopes integration reads by both tenant and integration identifiers", async () => {
    const db = database();
    const store = new PostgresIntegrationRegistryStore(db.client);
    await expect(store.get("tenant-a", "pos-main")).resolves.toBeNull();
    expect(db.query.mock.calls[0]?.[0]).toContain("WHERE tenant_id = $1 AND id = $2");
    expect(db.query.mock.calls[0]?.[1]).toEqual(["tenant-a", "pos-main"]);
  });

  it("scopes lists by tenant and optional family, mapping database rows", async () => {
    const db = database({
      rowCount: 1,
      rows: [{
        id: registration.id,
        tenant_id: registration.tenantId,
        family: registration.family,
        provider_key: registration.providerKey,
        display_name: registration.displayName,
        status: registration.status,
        secret_reference: registration.secretReference,
        capabilities: registration.capabilities,
        created_at: new Date(registration.createdAtUtc),
        updated_at: new Date(registration.updatedAtUtc)
      }]
    });
    const store = new PostgresIntegrationRegistryStore(db.client);
    await expect(store.list("tenant-a", "pos")).resolves.toEqual([registration]);
    expect(db.query.mock.calls[0]?.[0]).toContain("tenant_id = $1");
    expect(db.query.mock.calls[0]?.[1]).toEqual(["tenant-a", "pos"]);
  });

  it("inserts registrations without overwriting an existing tenant-scoped key", async () => {
    const db = database({ rows: [{ id: registration.id }], rowCount: 1 });
    const store = new PostgresIntegrationRegistryStore(db.client);
    await store.put(registration);
    const [sql, values] = db.query.mock.calls[0] ?? [];
    expect(sql).toContain("ON CONFLICT (tenant_id, id) DO NOTHING");
    expect(sql).toContain("RETURNING id");
    expect(values).toContain("tenant-a");
    expect(values).toContain(JSON.stringify(registration.capabilities));

    const duplicateDb = database({ rows: [], rowCount: 0 });
    const duplicateStore = new PostgresIntegrationRegistryStore(duplicateDb.client);
    await expect(duplicateStore.put(registration)).rejects.toThrow("INTEGRATION_ALREADY_EXISTS");
  });

  it("rotates only the tenant-scoped opaque secret reference", async () => {
    const db = database({ rows: [{ id: "pos-main" }], rowCount: 1 });
    const store = new PostgresIntegrationRegistryStore(db.client);
    await expect(store.updateSecretReference(
      "tenant-a", "pos-main", "vault://tenant-a/pos-main-v2", "2026-11-08T10:02:00.000Z"
    )).resolves.toBe("updated");
    const [sql, values] = db.query.mock.calls[0] ?? [];
    expect(sql).toContain("SET secret_reference = $3, updated_at = $4");
    expect(sql).toContain("WHERE tenant_id = $1 AND id = $2");
    expect(values).toEqual([
      "tenant-a", "pos-main", "vault://tenant-a/pos-main-v2", "2026-11-08T10:02:00.000Z"
    ]);
    const missingDb = database({ rows: [], rowCount: 0 });
    await expect(new PostgresIntegrationRegistryStore(missingDb.client).updateSecretReference(
      "tenant-a", "missing", "vault://tenant-a/pos-main-v2", "2026-11-08T10:02:00.000Z"
    )).resolves.toBe("not_found");
  });

  it("updates integration lifecycle state with tenant and expected-status compare-and-set", async () => {
    const db = database({ rows: [{ id: "pos-main" }], rowCount: 1 });
    const store = new PostgresIntegrationRegistryStore(db.client);
    await expect(store.updateStatus(
      "tenant-a", "pos-main", "connected", "suspended", "2026-11-08T10:02:00.000Z"
    )).resolves.toBe("updated");
    const [sql, values] = db.query.mock.calls[0] ?? [];
    expect(sql).toContain("WHERE tenant_id = $1 AND id = $2 AND status = $3");
    expect(sql).toContain("updated_at <= $5");
    expect(values).toEqual([
      "tenant-a", "pos-main", "connected", "suspended", "2026-11-08T10:02:00.000Z"
    ]);

    const conflictDb = database({ rows: [], rowCount: 0 });
    const conflictStore = new PostgresIntegrationRegistryStore(conflictDb.client);
    await expect(conflictStore.updateStatus(
      "tenant-a", "pos-main", "connected", "suspended", "2026-11-08T10:02:00.000Z"
    )).resolves.toBe("conflict");
  });

  it("stores object payloads with a digest and reports inserted versus duplicate events", async () => {
    const insertedDb = database({ rows: [{ id: "event-1" }], rowCount: 1 });
    const inserted = new PostgresIntegrationRegistryStore(insertedDb.client);
    await expect(inserted.recordEvent(event)).resolves.toBe("inserted");
    const [insertSql, insertValues] = insertedDb.query.mock.calls[0] ?? [];
    expect(insertSql).toContain("ON CONFLICT DO NOTHING RETURNING id");
    expect(insertSql).toContain("payload_sha256");
    expect(insertValues).toContain(JSON.stringify(event.payload));

    const duplicateDb = database({ rows: [], rowCount: 0 });
    const duplicate = new PostgresIntegrationRegistryStore(duplicateDb.client);
    await expect(duplicate.recordEvent(event)).resolves.toBe("duplicate");
  });

  it("rejects primitive event payloads before issuing SQL", async () => {
    const db = database();
    const store = new PostgresIntegrationRegistryStore(db.client);
    await expect(store.recordEvent({ ...event, payload: "not-an-object" })).rejects.toThrow(
      "INVALID_INTEGRATION_EVENT_PAYLOAD"
    );
    expect(db.query).not.toHaveBeenCalled();
  });
});
