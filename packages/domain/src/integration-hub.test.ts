import { describe, expect, it } from "vitest";
import {
  InMemoryIntegrationRegistryStore,
  IntegrationHub,
  type IntegrationRegistration
} from "./integration-hub.js";

const connected: IntegrationRegistration = {
  id: "pos-main", tenantId: "tenant-a", family: "pos", providerKey: "generic-pos",
  displayName: "Main branch POS", status: "connected",
  secretReference: "vault://tenant-a/pos-main",
  capabilities: ["catalog.read", "inventory.read", "inventory.write", "inventory.read"],
  createdAtUtc: "2026-11-08T10:00:00Z", updatedAtUtc: "2026-11-08T10:00:00Z"
};

describe("multi-family integration hub", () => {
  it("registers integrations without storing secret material and de-duplicates capabilities", async () => {
    const store = new InMemoryIntegrationRegistryStore();
    const hub = new IntegrationHub(store);
    await hub.register(connected);
    const result = await hub.list("tenant-a", "pos");
    expect(result).toHaveLength(1);
    expect(result[0].secretReference).toBe("vault://tenant-a/pos-main");
    expect(result[0].capabilities).toEqual(["catalog.read", "inventory.read", "inventory.write"]);
  });

  it("isolates registrations by tenant", async () => {
    const hub = new IntegrationHub(new InMemoryIntegrationRegistryStore());
    await hub.register(connected);
    expect(await hub.list("tenant-b")).toEqual([]);
    expect(await hub.acceptEvent({
      tenantId: "tenant-b", integrationId: "pos-main", providerEventId: "evt-1",
      eventType: "inventory.updated", occurredAtUtc: "2026-11-08T10:01:00Z",
      idempotencyKey: "key-1", payload: { sku: "SKU-1", quantity: 4 }
    })).toMatchObject({ accepted: false, reason: "integration_not_found" });
  });

  it("accepts connected integration events once and identifies provider retries", async () => {
    const hub = new IntegrationHub(new InMemoryIntegrationRegistryStore());
    await hub.register(connected);
    const event = {
      tenantId: "tenant-a", integrationId: "pos-main", providerEventId: "evt-1",
      eventType: "inventory.updated", occurredAtUtc: "2026-11-08T10:01:00Z",
      idempotencyKey: "key-1", payload: { sku: "SKU-1", quantity: 4 }
    };
    await expect(hub.acceptEvent(event)).resolves.toEqual({ accepted: true, duplicate: false });
    await expect(hub.acceptEvent(event)).resolves.toEqual({ accepted: true, duplicate: true });
  });

  it("rejects events from pending, degraded, suspended or disconnected integrations", async () => {
    const store = new InMemoryIntegrationRegistryStore();
    const hub = new IntegrationHub(store);
    await hub.register({ ...connected, status: "degraded" });
    await expect(hub.acceptEvent({
      tenantId: "tenant-a", integrationId: "pos-main", providerEventId: "evt-1",
      eventType: "inventory.updated", occurredAtUtc: "2026-11-08T10:01:00Z",
      idempotencyKey: "key-1", payload: {}
    })).resolves.toMatchObject({ accepted: false, reason: "integration_not_active" });
  });

  it("rejects invalid registration metadata and invalid event timestamps", async () => {
    const hub = new IntegrationHub(new InMemoryIntegrationRegistryStore());
    await expect(hub.register({ ...connected, family: "unknown" as "pos" })).rejects.toThrow("INVALID_INTEGRATION_REGISTRATION");
    await hub.register(connected);
    await expect(hub.acceptEvent({
      tenantId: "tenant-a", integrationId: "pos-main", providerEventId: "evt-2",
      eventType: "inventory.updated", occurredAtUtc: "yesterday",
      idempotencyKey: "key-2", payload: {}
    })).resolves.toMatchObject({ accepted: false, reason: "invalid_event" });
  });
});
