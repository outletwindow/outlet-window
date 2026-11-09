import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

export type CatalogSourceType = "official_api" | "merchant_feed" | "structured_data" | "html_page" | "manual";
export type CatalogAvailability = "in_stock" | "out_of_stock" | "preorder" | "unknown";

export interface CatalogVariantInput {
  externalVariantId: string;
  sku?: string;
  barcode?: string;
  sizeLabel?: string;
  colorLabel?: string;
  currency?: string;
  priceMinor?: number;
  availability?: CatalogAvailability;
}
export interface CatalogProductInput {
  tenantId: string;
  integrationId: string;
  providerKey: string;
  externalProductId: string;
  canonicalUrl: string;
  title: string;
  description?: string;
  brand?: string;
  currency?: string;
  priceMinor?: number;
  imageUrls: readonly string[];
  sourceType: CatalogSourceType;
  sourceCapturedAt: string;
  sourceContentSha256: string;
  sizeChartUrl?: string;
  variants: readonly CatalogVariantInput[];
}
export interface CatalogProductRecord extends Omit<CatalogProductInput, "variants"> {
  id: string;
  variants: Array<CatalogVariantInput & { id: string }>;
  createdAt: string;
  updatedAt: string;
}

/** PostgreSQL catalog writer/reader. All reads and writes are scoped by merchant tenant. */
export class PostgresMerchantCatalog {
  constructor(private readonly pool: PostgresPool) {}

  async createProduct(input: CatalogProductInput): Promise<CatalogProductRecord> {
    const client = await this.pool.connect();
    const productId = randomUUID();
    const now = new Date().toISOString();
    try {
      await client.query("BEGIN");
      const integration = await client.query<{ id: string }>(
        `SELECT id FROM tenant_integrations
         WHERE tenant_id = $1 AND id = $2 AND provider_key = $3
           AND family IN ('commerce','pos','erp') AND status = 'connected'
         FOR SHARE`,
        [input.tenantId, input.integrationId, input.providerKey]
      );
      if (!integration.rowCount) {
        await client.query("ROLLBACK");
        throw new Error("CATALOG_INTEGRATION_NOT_CONNECTED");
      }
      await client.query(
        `INSERT INTO commerce_catalog_products
         (id,tenant_id,integration_id,provider_key,external_product_id,canonical_url,title,
          description,brand,currency,price_minor,image_urls,source_type,source_captured_at,
          source_content_sha256,size_chart_url,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$17)`,
        [productId,input.tenantId,input.integrationId,input.providerKey,input.externalProductId,
         input.canonicalUrl,input.title,input.description ?? null,input.brand ?? null,
         input.currency ?? null,input.priceMinor ?? null,JSON.stringify(input.imageUrls),
         input.sourceType,input.sourceCapturedAt,input.sourceContentSha256,input.sizeChartUrl ?? null,now]
      );
      const variants: Array<CatalogVariantInput & { id: string }> = [];
      for (const variant of input.variants) {
        const id = randomUUID();
        await client.query(
          `INSERT INTO commerce_catalog_variants
           (id,tenant_id,product_id,external_variant_id,sku,barcode,size_label,color_label,
            currency,price_minor,availability,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
          [id,input.tenantId,productId,variant.externalVariantId,variant.sku ?? null,
           variant.barcode ?? null,variant.sizeLabel ?? null,variant.colorLabel ?? null,
           variant.currency ?? null,variant.priceMinor ?? null,variant.availability ?? "unknown",now]
        );
        variants.push({ ...variant, id });
      }
      await client.query("COMMIT");
      return { ...input, id: productId, variants, createdAt: now, updatedAt: now };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      if (typeof error === "object" && error !== null && "code" in error &&
          (error as { code?: unknown }).code === "23505") {
        throw new Error("CATALOG_PRODUCT_ALREADY_EXISTS");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listProducts(tenantId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT p.id,p.integration_id AS "integrationId",p.provider_key AS "providerKey",
        p.external_product_id AS "externalProductId",p.canonical_url AS "canonicalUrl",
        p.title,p.description,p.brand,p.currency,p.price_minor AS "priceMinor",
        p.image_urls AS "imageUrls",p.source_type AS "sourceType",
        p.source_captured_at AS "sourceCapturedAt",p.created_at AS "createdAt",
        p.updated_at AS "updatedAt",
        COALESCE(jsonb_agg(jsonb_build_object(
          'id',v.id,'externalVariantId',v.external_variant_id,'sku',v.sku,
          'barcode',v.barcode,'sizeLabel',v.size_label,'colorLabel',v.color_label,
          'currency',v.currency,'priceMinor',v.price_minor,'availability',v.availability
        )) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS variants
       FROM commerce_catalog_products p
       LEFT JOIN commerce_catalog_variants v
         ON v.tenant_id = p.tenant_id AND v.product_id = p.id
       WHERE p.tenant_id = $1
       GROUP BY p.id
       ORDER BY p.updated_at DESC
       LIMIT $2`,
      [tenantId, limit]
    );
    return result.rows;
  }
}
