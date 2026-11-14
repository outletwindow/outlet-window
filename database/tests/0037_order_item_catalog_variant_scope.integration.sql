\set ON_ERROR_STOP on
BEGIN;
INSERT INTO identities (id,principal_type,status,primary_email,created_at,updated_at)
VALUES ('ow-order-scope-customer','human','active','order-scope@example.test',now(),now());

INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES
 ('ow-order-scope-merchant-a','OW Order Scope A LLC','OW Order Scope A','SA','active'),
 ('ow-order-scope-merchant-b','OW Order Scope B LLC','OW Order Scope B','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES
 ('ow-order-scope-branch-a','ow-order-scope-merchant-a','OW Order Scope Branch A','DMM','active'),
 ('ow-order-scope-branch-b','ow-order-scope-merchant-b','OW Order Scope Branch B','DMM','active');
INSERT INTO tenant_integrations (id,tenant_id,family,provider_key,display_name,status,capabilities,created_at,updated_at)
VALUES
 ('ow-order-scope-integration-a','ow-order-scope-merchant-a','commerce','order-scope-a','Order Scope A','connected','["catalog.read"]',now(),now()),
 ('ow-order-scope-integration-b','ow-order-scope-merchant-b','commerce','order-scope-b','Order Scope B','connected','["catalog.read"]',now(),now());
INSERT INTO commerce_catalog_products
 (id,tenant_id,integration_id,provider_key,external_product_id,canonical_url,title,currency,price_minor,image_urls,source_type,source_captured_at,source_content_sha256,published_at,publication_updated_at)
VALUES
 ('ow-order-scope-product-a','ow-order-scope-merchant-a','ow-order-scope-integration-a','order-scope-a','product-a','https://merchant-a.example/product','Product A','SAR',1000,'[]','manual',now(),repeat('a',64),now(),now()),
 ('ow-order-scope-product-b','ow-order-scope-merchant-b','ow-order-scope-integration-b','order-scope-b','product-b','https://merchant-b.example/product','Product B','SAR',1000,'[]','manual',now(),repeat('b',64),now(),now());
INSERT INTO commerce_catalog_variants
 (id,tenant_id,product_id,external_variant_id,sku,currency,price_minor,availability)
VALUES
 ('ow-order-scope-variant-a','ow-order-scope-merchant-a','ow-order-scope-product-a','external-a','SKU-A','SAR',1000,'in_stock'),
 ('ow-order-scope-variant-a2','ow-order-scope-merchant-a','ow-order-scope-product-a','external-a2','SKU-A2','SAR',1000,'in_stock'),
 ('ow-order-scope-variant-b','ow-order-scope-merchant-b','ow-order-scope-product-b','external-b','SKU-B','SAR',1000,'in_stock');

INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('ow-order-scope-order','platform','ow-order-scope-customer','order-scope-key-0001','pending_validation','SAR',1000);
INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('ow-order-scope-suborder','ow-order-scope-merchant-a','ow-order-scope-order','ow-order-scope-merchant-a','ow-order-scope-branch-a','pending_validation',1000);

INSERT INTO customer_order_items
 (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,product_variant_id,sku,quantity,unit_price_minor,currency)
VALUES
 ('ow-order-scope-item-valid','ow-order-scope-merchant-a','ow-order-scope-order','ow-order-scope-suborder','ow-order-scope-merchant-a','ow-order-scope-branch-a','ow-order-scope-variant-a','SKU-A',1,1000,'SAR');

DO $$
BEGIN
  BEGIN
    INSERT INTO customer_order_items
     (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,product_variant_id,sku,quantity,unit_price_minor,currency)
    VALUES
     ('ow-order-scope-item-wrong-sku','ow-order-scope-merchant-a','ow-order-scope-order','ow-order-scope-suborder','ow-order-scope-merchant-a','ow-order-scope-branch-a','ow-order-scope-variant-a2','SKU-WRONG',1,1000,'SAR');
    RAISE EXCEPTION 'mismatched catalog SKU unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO customer_order_items
     (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,product_variant_id,sku,quantity,unit_price_minor,currency)
    VALUES
     ('ow-order-scope-item-wrong-tenant','ow-order-scope-merchant-a','ow-order-scope-order','ow-order-scope-suborder','ow-order-scope-merchant-a','ow-order-scope-branch-a','ow-order-scope-variant-b','SKU-B',1,1000,'SAR');
    RAISE EXCEPTION 'cross-tenant catalog variant unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
ROLLBACK;
