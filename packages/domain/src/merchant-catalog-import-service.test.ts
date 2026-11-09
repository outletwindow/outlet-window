import { describe, expect, it } from "vitest";
import {
  CommerceConnectorRegistry,
  type CommerceCatalogAdapter
} from "./commerce-connectors.js";
import {
  IntegrationHub,
  InMemoryIntegrationRegistryStore
} from "./integration-hub.js";
import { MerchantCatalogImportService } from "./merchant-catalog-import-service.js";

const now = "2026-11-09T00:00:00.000Z";
const adapter: CommerceCatalogAdapter = {
  descriptor: {
    providerKey: "salla", displayName: "Salla test", websiteHosts: ["shop.example"],
    regions: ["SA"], sourceTypes: ["official_api"], capabilities: ["catalog_read"],
    implementationStatus: "adapter_available"
  },
  validateSourceUrl: url => url.protocol === "https:" && url.hostname === "shop.example",
  importPage: async request => ({
    products: [], completed: true, capturedAtUtc: now
  })
};

describe("MerchantCatalogImportService", () => {
  async function setup(status: "connected" | "pending" = "connected") {
    const store = new InMemoryIntegrationRegistryStore();
    const hub = new IntegrationHub(store);
    await hub.register({
      id: "salla-main", tenantId: "tenant-a", family: "commerce",
      providerKey: "salla", displayName: "Salla", status,
      capabilities: ["catalog_read"], createdAtUtc: now, updatedAtUtc: now
    });
    const registry = new CommerceConnectorRegistry();
    registry.register(adapter);
    const persisted: unknown[] = [];
    const importStore = {
      upsertPage: async (input: unknown) => { persisted.push(input); }
    };
    return { service: new MerchantCatalogImportService(hub, registry, importStore), persisted };
  }

  it("imports only through the connected tenant integration and registered provider", async () => {
    const { service, persisted } = await setup();
    const result = await service.import({
      tenantId: "tenant-a", integrationId: "salla-main", sourceUrl: "https://shop.example"
    });
    expect(result).toEqual({ pagesImported: 1, productsImported: 0, completed: true });
    expect(persisted).toHaveLength(1);
  });

  it("does not reveal or import another tenant integration", async () => {
    const { service } = await setup();
    await expect(service.import({
      tenantId: "tenant-b", integrationId: "salla-main", sourceUrl: "https://shop.example"
    })).rejects.toThrow("CATALOG_INTEGRATION_NOT_FOUND");
  });

  it("rejects integrations that are not connected", async () => {
    const { service } = await setup("pending");
    await expect(service.import({
      tenantId: "tenant-a", integrationId: "salla-main", sourceUrl: "https://shop.example"
    })).rejects.toThrow("CATALOG_INTEGRATION_NOT_CONNECTED");
  });

  it("rejects untrusted provider hosts before importing", async () => {
    const { service } = await setup();
    await expect(service.import({
      tenantId: "tenant-a", integrationId: "salla-main", sourceUrl: "https://attacker.example"
    })).rejects.toThrow("UNTRUSTED_CATALOG_SOURCE");
  });
});
