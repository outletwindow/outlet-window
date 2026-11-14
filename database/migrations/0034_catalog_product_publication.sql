-- Products remain hidden from customer discovery until explicitly published.
ALTER TABLE commerce_catalog_products ADD COLUMN published_at timestamptz, ADD COLUMN publication_updated_at timestamptz;
CREATE INDEX commerce_catalog_products_published_idx ON commerce_catalog_products (tenant_id, published_at DESC) WHERE published_at IS NOT NULL;
