import type { CommerceConnectorRegistry } from "./commerce-connectors.js";
import { CommerceCatalogImporter, type CommerceCatalogImportSummary } from "./commerce-catalog-importer.js";
import type { CommerceCatalogImportStore } from "./commerce-catalog-importer.js";
import type { IntegrationHub } from "./integration-hub.js";

/** Tenant- and integration-scoped import entry point. Provider identity is read
 * from the trusted integration registry, never accepted from the caller. */
export class MerchantCatalogImportService {
  constructor(
    private readonly integrations: IntegrationHub,
    private readonly connectors: CommerceConnectorRegistry,
    private readonly store: CommerceCatalogImportStore
  ) {}

  async import(input: {
    tenantId: string;
    integrationId: string;
    sourceUrl: string;
    cursor?: string;
    updatedSinceUtc?: string;
  }): Promise<CommerceCatalogImportSummary> {
    const integration = await this.integrations.get(input.tenantId, input.integrationId);
    if (!integration) throw new Error("CATALOG_INTEGRATION_NOT_FOUND");
    if (integration.status !== "connected") throw new Error("CATALOG_INTEGRATION_NOT_CONNECTED");
    if (!["commerce", "pos", "erp"].includes(integration.family)) {
      throw new Error("CATALOG_INTEGRATION_FAMILY_UNSUPPORTED");
    }
    const adapter = this.connectors.get(integration.providerKey);
    if (!adapter) throw new Error("CATALOG_PROVIDER_NOT_CONFIGURED");
    const importer = new CommerceCatalogImporter(adapter, this.store, {
      maxPages: 20,
      maxProductsPerPage: 500
    });
    return importer.import({
      tenantId: input.tenantId,
      integrationId: input.integrationId,
      sourceUrl: input.sourceUrl,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.updatedSinceUtc === undefined ? {} : { updatedSinceUtc: input.updatedSinceUtc })
    });
  }
}
