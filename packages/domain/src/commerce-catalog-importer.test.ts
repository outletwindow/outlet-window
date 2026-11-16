import { describe, expect, it } from "vitest";
import { CENTREPOINT_SA_PROVIDER, type CommerceCatalogAdapter, type NormalizedCommerceProduct } from "./commerce-connectors.js";
import { CommerceCatalogImporter, type CommerceCatalogImportStore } from "./commerce-catalog-importer.js";

const product: NormalizedCommerceProduct = {
  tenantId: "tenant-1", providerKey: "centrepoint-sa", externalProductId: "p-1",
  canonicalUrl: "https://www.centrepointstores.com/p/1", title: "Shirt",
  imageUrls: [], variants: [], sourceType: "structured_data",
  sourceCapturedAtUtc: "2026-11-08T10:00:00.000Z", sourceContentSha256: "a".repeat(64)
};
function setup(pages: Array<any>, limits = {}) {
  let index = 0;
  const adapter: CommerceCatalogAdapter = {
    descriptor: CENTREPOINT_SA_PROVIDER,
    validateSourceUrl: url => url.protocol === "https:" && url.hostname === "www.centrepointstores.com",
    async importPage() { return pages[index++] ?? pages[pages.length - 1]; }
  };
  const writes: unknown[] = [];
  const store: CommerceCatalogImportStore = { async upsertPage(input) { writes.push(input); } };
  return { importer: new CommerceCatalogImporter(adapter, store, limits), writes };
}
describe("bounded commerce catalog importer", () => {
  it("imports and persists a valid page for the requesting tenant", async () => {
    const { importer, writes } = setup([{ products: [product], completed: true, capturedAtUtc: "2026-11-08T10:00:00.000Z" }]);
    await expect(importer.import({ tenantId: "tenant-1", integrationId: "int-1", sourceUrl: "https://www.centrepointstores.com/sa" }))
      .resolves.toMatchObject({ pagesImported: 1, productsImported: 1, completed: true });
    expect(writes).toHaveLength(1);
  });
  it("rejects a product that attempts cross-tenant import before persistence", async () => {
    const { importer, writes } = setup([{ products: [{ ...product, tenantId: "tenant-2" }], completed: true, capturedAtUtc: "2026-11-08T10:00:00.000Z" }]);
    await expect(importer.import({ tenantId: "tenant-1", integrationId: "int-1", sourceUrl: "https://www.centrepointstores.com" }))
      .rejects.toThrow("UNTRUSTED_OR_INVALID_IMPORTED_PRODUCT");
    expect(writes).toHaveLength(0);
  });
  it("rejects an untrusted source URL", async () => {
    const { importer } = setup([]);
    await expect(importer.import({ tenantId: "tenant-1", integrationId: "int-1", sourceUrl: "https://attacker.example" }))
      .rejects.toThrow("UNTRUSTED_CATALOG_SOURCE");
  });
  it("rejects repeated pagination cursors", async () => {
    const { importer, writes } = setup([
      { products: [], completed: false, nextCursor: "next", capturedAtUtc: "2026-11-08T10:00:00.000Z" },
      { products: [], completed: false, nextCursor: "next", capturedAtUtc: "2026-11-08T10:00:00.000Z" }
    ]);
    await expect(importer.import({ tenantId: "tenant-1", integrationId: "int-1", sourceUrl: "https://www.centrepointstores.com" }))
      .rejects.toThrow("INVALID_OR_REPEATED_CATALOG_CURSOR");
    expect(writes).toHaveLength(1);
  });
  it("stops at the configured page bound and returns the resume cursor", async () => {
    const { importer } = setup([
      { products: [], completed: false, nextCursor: "page-2", capturedAtUtc: "2026-11-08T10:00:00.000Z" },
      { products: [], completed: false, nextCursor: "page-3", capturedAtUtc: "2026-11-08T10:00:00.000Z" }
    ], { maxPages: 2 });
    await expect(importer.import({ tenantId: "tenant-1", integrationId: "int-1", sourceUrl: "https://www.centrepointstores.com" }))
      .resolves.toMatchObject({ pagesImported: 2, completed: false, nextCursor: "page-3" });
  });
});
