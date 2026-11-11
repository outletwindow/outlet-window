BEGIN;
INSERT INTO merchants (id,legal_name,display_name,country_code,status,created_at,updated_at)
VALUES ('publication-merchant-a','Publication Merchant A LLC','Publication Merchant A','SA','active',now(),now()) ON CONFLICT DO NOTHING;
INSERT INTO tenant_integrations (id,tenant_id,family,provider_key,display_name,status,capabilities,created_at,updated_at)
VALUES ('publication-integration-a','publication-merchant-a','commerce','publication-pos','Publication POS','connected','["catalog.read"]',now(),now()) ON CONFLICT DO NOTHING;
INSERT INTO commerce_catalog_products (id,tenant_id,integration_id,provider_key,external_product_id,canonical_url,title,image_urls,source_type,source_captured_at,source_content_sha256)
VALUES ('publication-product-a','publication-merchant-a','publication-integration-a','publication-pos','external-a','https://merchant.example/p/a','Hidden by default','[]','manual',now(),repeat('a',64));
DO $$
DECLARE stamp timestamptz;
BEGIN
 IF EXISTS (SELECT 1 FROM commerce_catalog_products WHERE tenant_id='publication-merchant-a' AND id='publication-product-a' AND published_at IS NOT NULL) THEN RAISE EXCEPTION 'new product must be hidden'; END IF;
 UPDATE commerce_catalog_products SET published_at=clock_timestamp(),publication_updated_at=clock_timestamp() WHERE tenant_id='publication-merchant-a' AND id='publication-product-a' RETURNING published_at INTO stamp;
 IF stamp IS NULL THEN RAISE EXCEPTION 'publish timestamp missing'; END IF;
 UPDATE commerce_catalog_products SET published_at=NULL,publication_updated_at=clock_timestamp() WHERE tenant_id='publication-merchant-a' AND id='publication-product-a';
 IF EXISTS (SELECT 1 FROM commerce_catalog_products WHERE tenant_id='publication-merchant-a' AND id='publication-product-a' AND published_at IS NOT NULL) THEN RAISE EXCEPTION 'unpublish failed'; END IF;
END $$;
ROLLBACK;
