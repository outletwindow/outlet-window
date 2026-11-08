-- Durable, tenant-isolated normalized merchant catalog.
CREATE TABLE commerce_catalog_products (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  integration_id text NOT NULL,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  external_product_id text NOT NULL CHECK (length(trim(external_product_id)) BETWEEN 1 AND 200),
  canonical_url text NOT NULL CHECK (canonical_url ~ '^https://'),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
  description text,
  brand text,
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(image_urls) = 'array'),
  source_type text NOT NULL CHECK (source_type IN ('official_api','merchant_feed','structured_data','html_page','manual')),
  source_captured_at timestamptz NOT NULL,
  source_content_sha256 char(64) NOT NULL CHECK (source_content_sha256 ~ '^[a-f0-9]{64}$'),
  size_chart_url text CHECK (size_chart_url IS NULL OR size_chart_url ~ '^https://'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, integration_id)
    REFERENCES tenant_integrations (tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, integration_id, provider_key, external_product_id)
);
CREATE INDEX commerce_catalog_products_tenant_updated_idx
  ON commerce_catalog_products (tenant_id, updated_at DESC);
CREATE INDEX commerce_catalog_products_provider_idx
  ON commerce_catalog_products (tenant_id, provider_key, external_product_id);

CREATE TABLE commerce_catalog_variants (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  product_id text NOT NULL REFERENCES commerce_catalog_products(id) ON DELETE CASCADE,
  external_variant_id text NOT NULL CHECK (length(trim(external_variant_id)) BETWEEN 1 AND 200),
  sku text,
  barcode text,
  size_label text,
  color_label text,
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  availability text NOT NULL DEFAULT 'unknown'
    CHECK (availability IN ('in_stock','out_of_stock','preorder','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, product_id)
    REFERENCES commerce_catalog_products (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, product_id, external_variant_id)
);
CREATE INDEX commerce_catalog_variants_tenant_product_idx
  ON commerce_catalog_variants (tenant_id, product_id);
