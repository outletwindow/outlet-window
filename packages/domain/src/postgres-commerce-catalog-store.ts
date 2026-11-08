import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";
import type { CommerceCatalogImportStore } from "./commerce-catalog-importer.js";
import type { NormalizedCommerceProduct } from "./commerce-connectors.js";

/** Atomic PostgreSQL persistence for normalized products and variants. */
export class PostgresCommerceCatalogStore implements CommerceCatalogImportStore {
  constructor(private readonly pool: PostgresPool) {}

  async upsertPage(input: Parameters<CommerceCatalogImportStore["upsertPage"]>[0]): Promise<void> {
    if (!input.tenantId.trim() || !input.integrationId.trim() ||
        !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(input.providerKey) ||
        !Number.isFinite(Date.parse(input.capturedAtUtc)) || !input.capturedAtUtc.endsWith("Z") ||
        input.products.length > 2000) {
      throw new Error("INVALID_CATALOG_PERSISTENCE_REQUEST");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const product of input.products) {
        if (product.tenantId !== input.tenantId || product.providerKey !== input.providerKey) {
          throw new Error("CATALOG_TENANT_OR_PROVIDER_MISMATCH");
        }
        const result = await client.query<{ id: string }>(
          \`INSERT INTO commerce_catalog_products
           (id,tenant_id,integration_id,provider_key,external_product_id,canonical_url,title,
            description,brand,currency,price_minor,image_urls,source_type,source_captured_at,
            source_content_sha256,size_chart_url,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,now())
           ON CONFLICT (tenant_id,integration_id,provider_key,external_product_id)
           DO UPDATE SET canonical_url=EXCLUDED.canonical_url,title=EXCLUDED.title,
            description=EXCLUDED.description,brand=EXCLUDED.brand,currency=EXCLUDED.currency,
            price_minor=EXCLUDED.price_minor,image_urls=EXCLUDED.image_urls,
            source_type=EXCLUDED.source_type,source_captured_at=EXCLUDED.source_captured_at,
            source_content_sha256=EXCLUDED.source_content_sha256,size_chart_url=EXCLUDED.size_chart_url,
            updated_at=now()
           WHERE commerce_catalog_products.source_captured_at <= EXCLUDED.source_captured_at
           RETURNING id\`,
          [randomUUID(),input.tenantId,input.integrationId,input.providerKey,product.externalProductId,
            product.canonicalUrl,product.title,product.description ?? null,product.brand ?? null,
            product.currency ?? null,product.priceMinor ?? null,JSON.stringify(product.imageUrls),
            product.sourceType,product.sourceCapturedAtUtc,product.sourceContentSha256,
            product.sizeChartUrl ?? null]
        );
        const productId = result.rows[0]?.id;
        if (!productId) continue; // Ignore stale source snapshots; never overwrite newer data.
        await client.query(
          "DELETE FROM commerce_catalog_variants WHERE tenant_id=$1 AND product_id=$2",
          [input.tenantId,productId]
        );
        for (const variant of product.variants) {
          await client.query(
            \`INSERT INTO commerce_catalog_variants
             (id,tenant_id,product_id,external_variant_id,sku,barcode,size_label,color_label,
              currency,price_minor,availability)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)\`,
            [randomUUID(),input.tenantId,productId,variant.externalId,variant.sku ?? null,
              variant.barcode ?? null,variant.sizeLabel ?? null,variant.colorLabel ?? null,
              variant.currency ?? product.currency ?? null,variant.priceMinor ?? null,
              variant.availability ?? "unknown"]
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
