\set ON_ERROR_STOP on
BEGIN;

INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES
 ('ow-customer-merchant-a','OW Customer Merchant A LLC','OW Customer Merchant A','SA','active'),
 ('ow-customer-merchant-b','OW Customer Merchant B LLC','OW Customer Merchant B','SA','active');

INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES
 ('ow-customer-branch-a','ow-customer-merchant-a','Active Branch','DMM','active'),
 ('ow-customer-branch-inactive','ow-customer-merchant-a','Inactive Branch','DMM','inactive'),
 ('ow-customer-branch-b','ow-customer-merchant-b','Other Merchant Branch','DMM','active');

INSERT INTO tenant_integrations
 (id,tenant_id,family,provider_key,display_name,status,capabilities,created_at,updated_at)
VALUES
 ('ow-customer-integration-a','ow-customer-merchant-a','commerce','customer-test-pos','Customer Catalog Test POS A','connected','["catalog.read"]',now(),now()),
 ('ow-customer-integration-b','ow-customer-merchant-b','commerce','customer-test-pos','Customer Catalog Test POS B','connected','["catalog.read"]',now(),now());

INSERT INTO commerce_catalog_products
 (id,tenant_id,integration_id,provider_key,external_product_id,canonical_url,title,image_urls,source_type,source_captured_at,source_content_sha256,published_at,publication_updated_at)
VALUES
 ('ow-customer-good','ow-customer-merchant-a','ow-customer-integration-a','customer-test-pos','good','https://merchant.example/good','Published in-stock item','[]','manual',now(),repeat('a',64),now(),now()),
 ('ow-customer-hidden','ow-customer-merchant-a','ow-customer-integration-a','customer-test-pos','hidden','https://merchant.example/hidden','Unpublished item','[]','manual',now(),repeat('b',64),NULL,NULL),
 ('ow-customer-stale','ow-customer-merchant-a','ow-customer-integration-a','customer-test-pos','stale','https://merchant.example/stale','Stale stock item','[]','manual',now(),repeat('c',64),now(),now()),
 ('ow-customer-low','ow-customer-merchant-a','ow-customer-integration-a','customer-test-pos','low','https://merchant.example/low','Low confidence item','[]','manual',now(),repeat('d',64),now(),now()),
 ('ow-customer-soldout','ow-customer-merchant-a','ow-customer-integration-a','customer-test-pos','soldout','https://merchant.example/soldout','Sold out item','[]','manual',now(),repeat('e',64),now(),now()),
 ('ow-customer-other','ow-customer-merchant-b','ow-customer-integration-b','customer-test-pos','other','https://merchant.example/other','Other merchant item','[]','manual',now(),repeat('f',64),now(),now());

INSERT INTO commerce_catalog_variants
 (id,tenant_id,product_id,external_variant_id,sku,size_label,availability)
VALUES
 ('ow-customer-v-good-m','ow-customer-merchant-a','ow-customer-good','ext-good-m','OW-GOOD-M','M','in_stock'),
 ('ow-customer-v-good-l','ow-customer-merchant-a','ow-customer-good','ext-good-l','OW-GOOD-L','L','in_stock'),
 ('ow-customer-v-hidden','ow-customer-merchant-a','ow-customer-hidden','ext-hidden','OW-HIDDEN','M','in_stock'),
 ('ow-customer-v-stale','ow-customer-merchant-a','ow-customer-stale','ext-stale','OW-STALE','M','in_stock'),
 ('ow-customer-v-low','ow-customer-merchant-a','ow-customer-low','ext-low','OW-LOW','M','in_stock'),
 ('ow-customer-v-soldout','ow-customer-merchant-a','ow-customer-soldout','ext-soldout','OW-SOLDOUT','M','in_stock'),
 ('ow-customer-v-other','ow-customer-merchant-b','ow-customer-other','ext-other','OW-OTHER','M','in_stock');

INSERT INTO branch_inventory
 (merchant_id,branch_id,product_variant_id,sku,available_quantity,reserved_quantity,source,last_synced_at,availability_confidence)
VALUES
 ('ow-customer-merchant-a','ow-customer-branch-a','ext-good-m','OW-GOOD-M',5,1,'merchant_portal',now(),'high'),
 ('ow-customer-merchant-a','ow-customer-branch-a','ext-good-l','OW-GOOD-L',3,0,'merchant_portal',now(),'medium'),
 ('ow-customer-merchant-a','ow-customer-branch-a','ext-hidden','OW-HIDDEN',5,0,'merchant_portal',now(),'high'),
 ('ow-customer-merchant-a','ow-customer-branch-a','ext-stale','OW-STALE',5,0,'merchant_portal',now()-interval '2 hours','high'),
 ('ow-customer-merchant-a','ow-customer-branch-a','ext-low','OW-LOW',5,0,'merchant_portal',now(),'low'),
 ('ow-customer-merchant-a','ow-customer-branch-a','ext-soldout','OW-SOLDOUT',2,2,'merchant_portal',now(),'high'),
 ('ow-customer-merchant-b','ow-customer-branch-b','ext-other','OW-OTHER',5,0,'merchant_portal',now(),'high');

DO $$
DECLARE
 visible_count integer;
 visible_product_count integer;
 inactive_count integer;
 cross_merchant_count integer;
BEGIN
 WITH selected_products AS (
   SELECT p.id
   FROM merchants m
   JOIN merchant_branches b ON b.merchant_id = m.id
   JOIN commerce_catalog_products p ON p.tenant_id = m.tenant_id
   WHERE m.id = 'ow-customer-merchant-a' AND b.id = 'ow-customer-branch-a'
     AND m.status = 'active' AND b.status = 'active'
     AND p.published_at IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM commerce_catalog_variants v
       JOIN branch_inventory i
         ON i.merchant_id = b.merchant_id AND i.branch_id = b.id
        AND i.product_variant_id = v.external_variant_id AND i.sku = v.sku
       WHERE v.tenant_id = p.tenant_id AND v.product_id = p.id
         AND v.sku IS NOT NULL
         AND i.availability_confidence IN ('high','medium')
         AND i.last_synced_at >= clock_timestamp() - interval '30 minutes'
         AND i.available_quantity - i.reserved_quantity > 0
     )
   ORDER BY p.updated_at DESC, p.id
   LIMIT 100
 )
 SELECT count(*), count(DISTINCT p.id)
 INTO visible_count, visible_product_count
 FROM selected_products selected
 JOIN commerce_catalog_products p ON p.id = selected.id
 JOIN commerce_catalog_variants v ON v.tenant_id = p.tenant_id AND v.product_id = p.id
 JOIN merchants m ON m.id = 'ow-customer-merchant-a'
 JOIN merchant_branches b ON b.merchant_id = m.id AND b.id = 'ow-customer-branch-a'
 JOIN branch_inventory i
   ON i.merchant_id = b.merchant_id AND i.branch_id = b.id
  AND i.product_variant_id = v.external_variant_id AND i.sku = v.sku
 WHERE v.sku IS NOT NULL
   AND i.availability_confidence IN ('high','medium')
   AND i.last_synced_at >= clock_timestamp() - interval '30 minutes'
   AND i.available_quantity - i.reserved_quantity > 0;

 IF visible_count <> 2 OR visible_product_count <> 1 THEN
   RAISE EXCEPTION 'expected both available variants from one published product; got % rows and % products', visible_count, visible_product_count;
 END IF;

 SELECT count(*) INTO inactive_count
 FROM merchants m
 JOIN merchant_branches b ON b.merchant_id = m.id
 JOIN commerce_catalog_products p ON p.tenant_id = m.tenant_id
 WHERE m.id = 'ow-customer-merchant-a' AND b.id = 'ow-customer-branch-inactive'
   AND m.status = 'active' AND b.status = 'active' AND p.published_at IS NOT NULL;

 IF inactive_count <> 0 THEN RAISE EXCEPTION 'inactive branch must not expose customer products'; END IF;

 SELECT count(*) INTO cross_merchant_count
 FROM merchants m
 JOIN merchant_branches b ON b.merchant_id = m.id
 JOIN commerce_catalog_products p ON p.tenant_id = m.tenant_id
 WHERE m.id = 'ow-customer-merchant-a' AND b.id = 'ow-customer-branch-b'
   AND m.status = 'active' AND b.status = 'active' AND p.published_at IS NOT NULL;

 IF cross_merchant_count <> 0 THEN RAISE EXCEPTION 'cross-merchant branch must not expose products'; END IF;
END $$;

ROLLBACK;
