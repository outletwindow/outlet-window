BEGIN;
INSERT INTO merchants (id, name, status, created_at, updated_at)
VALUES ('catalog-merchant-a', 'Catalog Merchant A', 'active', now(), now())
ON CONFLICT DO NOTHING;
INSERT INTO tenant_integrations
(id, tenant_id, family, provider_key, display_name, status, capabilities, created_at, updated_at)
VALUES ('catalog-integration-a','catalog-merchant-a','commerce','centrepoint-sa','Centrepoint test','connected','["catalog.read"]',now(),now())
ON CONFLICT DO NOTHING;

INSERT INTO commerce_catalog_products
(id,tenant_id,integration_id,provider_key,external_product_id,canonical_url,title,image_urls,source_type,source_captured_at,source_content_sha256)
VALUES ('catalog-product-a','catalog-merchant-a','catalog-integration-a','centrepoint-sa','ext-1',
'https://www.centrepointstores.com/p/1','Test product','[]','structured_data',now(),repeat('a',64));

INSERT INTO commerce_catalog_variants
(id,tenant_id,product_id,external_variant_id,size_label,availability)
VALUES ('catalog-variant-a','catalog-merchant-a','catalog-product-a','ext-v1','M','in_stock');

DO $$
BEGIN
  IF (SELECT count(*) FROM commerce_catalog_products WHERE tenant_id='catalog-merchant-a') <> 1 THEN
    RAISE EXCEPTION 'catalog product insert failed';
  END IF;
  IF (SELECT count(*) FROM commerce_catalog_variants WHERE tenant_id='catalog-merchant-a') <> 1 THEN
    RAISE EXCEPTION 'catalog variant insert failed';
  END IF;
  BEGIN
    INSERT INTO commerce_catalog_products
    (id,tenant_id,integration_id,provider_key,external_product_id,canonical_url,title,image_urls,source_type,source_captured_at,source_content_sha256)
    VALUES ('catalog-product-dup','catalog-merchant-a','catalog-integration-a','centrepoint-sa','ext-1',
    'https://www.centrepointstores.com/p/1','Duplicate','[]','structured_data',now(),repeat('b',64));
    RAISE EXCEPTION 'duplicate external product should be rejected';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO commerce_catalog_variants
    (id,tenant_id,product_id,external_variant_id)
    VALUES ('catalog-variant-cross','catalog-merchant-b','catalog-product-a','cross-tenant');
    RAISE EXCEPTION 'cross-tenant variant should be rejected';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
ROLLBACK;
