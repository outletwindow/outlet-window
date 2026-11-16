import {
  validateCommerceProductForProvider,
  type CommerceCatalogAdapter,
  type CommerceCatalogImportRequest,
  type NormalizedCommerceProduct
} from "./commerce-connectors.js";

export interface CommerceCatalogImportStore {
  /** Must upsert by tenant + integration + provider + external product identity. */
  upsertPage(input: {
    tenantId: string;
    integrationId: string;
    providerKey: string;
    products: readonly NormalizedCommerceProduct[];
    capturedAtUtc: string;
  }): Promise<void>;
}
export interface CommerceCatalogImportSummary {
  pagesImported: number;
  productsImported: number;
  completed: boolean;
  nextCursor?: string;
}
export interface CommerceCatalogImportLimits {
  maxPages?: number;
  maxProductsPerPage?: number;
}

function validUtc(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && value.endsWith("Z");
}

/**
 * Bounded, fail-closed catalog import orchestration.
 * HTTP transport, SSRF-safe DNS/IP checks, rate limits and provider parsing
 * remain responsibilities of the concrete adapter/runtime.
 */
export class CommerceCatalogImporter {
  constructor(
    private readonly adapter: CommerceCatalogAdapter,
    private readonly store: CommerceCatalogImportStore,
    private readonly limits: CommerceCatalogImportLimits = {}
  ) {}

  async import(request: CommerceCatalogImportRequest): Promise<CommerceCatalogImportSummary> {
    const maxPages = this.limits.maxPages ?? 20;
    const maxProducts = this.limits.maxProductsPerPage ?? 500;
    if (!request.tenantId.trim() || request.tenantId.length > 160 ||
        !request.integrationId.trim() || request.integrationId.length > 160 ||
        !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 ||
        !Number.isInteger(maxProducts) || maxProducts < 1 || maxProducts > 2000 ||
        (request.updatedSinceUtc !== undefined && !validUtc(request.updatedSinceUtc))) {
      throw new Error("INVALID_CATALOG_IMPORT_REQUEST");
    }

    let source: URL;
    try { source = new URL(request.sourceUrl); } catch {
      throw new Error("UNTRUSTED_CATALOG_SOURCE");
    }
    if (source.protocol !== "https:" || source.username || source.password ||
        source.port || !this.adapter.validateSourceUrl(source)) {
      throw new Error("UNTRUSTED_CATALOG_SOURCE");
    }

    let cursor = request.cursor;
    const seenCursors = new Set<string>();
    let pagesImported = 0;
    let productsImported = 0;

    while (pagesImported < maxPages) {
      if (cursor !== undefined) {
        if (!cursor.trim() || cursor.length > 2000 || seenCursors.has(cursor)) {
          throw new Error("INVALID_OR_REPEATED_CATALOG_CURSOR");
        }
        seenCursors.add(cursor);
      }

      const page = await this.adapter.importPage({
        ...request,
        ...(cursor !== undefined ? { cursor } : {})
      });
      if (!page || !Array.isArray(page.products) || page.products.length > maxProducts ||
          !validUtc(page.capturedAtUtc) || typeof page.completed !== "boolean" ||
          (page.nextCursor !== undefined && (typeof page.nextCursor !== "string" ||
            !page.nextCursor.trim() || page.nextCursor.length > 2000))) {
        throw new Error("INVALID_CATALOG_IMPORT_PAGE");
      }
      if (!page.completed && (!page.nextCursor || page.nextCursor === cursor ||
          seenCursors.has(page.nextCursor))) {
        throw new Error("INVALID_OR_REPEATED_CATALOG_CURSOR");
      }

      for (const product of page.products) {
        if (product.tenantId !== request.tenantId ||
            !validateCommerceProductForProvider(product, this.adapter.descriptor)) {
          throw new Error("UNTRUSTED_OR_INVALID_IMPORTED_PRODUCT");
        }
      }

      // Persist only after the entire page has passed validation.
      await this.store.upsertPage({
        tenantId: request.tenantId,
        integrationId: request.integrationId,
        providerKey: this.adapter.descriptor.providerKey,
        products: page.products,
        capturedAtUtc: page.capturedAtUtc
      });
      pagesImported += 1;
      productsImported += page.products.length;

      if (page.completed) return { pagesImported, productsImported, completed: true };
      cursor = page.nextCursor;
    }

    return {
      pagesImported,
      productsImported,
      completed: false,
      ...(cursor !== undefined ? { nextCursor: cursor } : {})
    };
  }
}
