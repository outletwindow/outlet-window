\set ON_ERROR_STOP on
BEGIN;
INSERT INTO identities (id,principal_type,status,primary_email,created_at,updated_at)
VALUES ('ow-cart-customer','human','active','cart-customer@example.test',now(),now());
INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES ('ow-cart-merchant','OW Cart Merchant LLC','OW Cart Merchant','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('ow-cart-branch','ow-cart-merchant','OW Cart Branch','DMM','active');
INSERT INTO tenant_integrations (id,tenant_id,family,provider_key,display_name,status,capabilities,created_at,updated_at)
VALUES ('ow-cart-integration','ow-cart-merchant','commerce','cart-test-pos','Cart Test POS','connected','["catalog.read"]',now(),now());
INSERT INTO commerce_catalog_products
 (id,tenant_id,integration_id,provider_key,external_product_id,canonical_url,title,currency,price_minor,image_urls,source_type,source_captured_at,source_content_sha256,published_at,publication_updated_at)
VALUES ('ow-cart-product','ow-cart-merchant','ow-cart-integration','cart-test-pos','shirt','https://merchant.example/shirt','Cart Shirt','SAR',12900,'[]','manual',now(),repeat('a',64),now(),now());
INSERT INTO commerce_catalog_variants
 (id,tenant_id,product_id,external_variant_id,sku,currency,price_minor,availability)
VALUES ('ow-cart-variant','ow-cart-merchant','ow-cart-product','ow-cart-external-variant','OW-CART-SKU','SAR',12900,'in_stock');
INSERT INTO branch_inventory
 (merchant_id,branch_id,product_variant_id,sku,available_quantity,reserved_quantity,source,last_synced_at,availability_confidence)
VALUES ('ow-cart-merchant','ow-cart-branch','ow-cart-external-variant','OW-CART-SKU',5,0,'merchant_portal',now(),'high');
INSERT INTO customer_carts (id,tenant_id,customer_id,status,currency)
VALUES ('ow-cart-a','platform','ow-cart-customer','active','SAR');
INSERT INTO customer_cart_items (id,tenant_id,cart_id,merchant_tenant_id,merchant_id,branch_id,product_variant_id,quantity)
VALUES ('ow-cart-item-a','platform','ow-cart-a','ow-cart-merchant','ow-cart-merchant','ow-cart-branch','ow-cart-variant',2);
DO $$
DECLARE cart_count integer; item_count integer;
BEGIN
 SELECT count(*) INTO cart_count FROM customer_carts
 WHERE tenant_id='platform' AND customer_id='ow-cart-customer' AND status='active';
 IF cart_count <> 1 THEN RAISE EXCEPTION 'expected one active customer cart'; END IF;
 SELECT count(*) INTO item_count FROM customer_cart_items i
 JOIN customer_carts c ON c.id=i.cart_id AND c.tenant_id=i.tenant_id
 JOIN commerce_catalog_variants v ON v.id=i.product_variant_id
 JOIN merchants m ON m.id=i.merchant_id AND m.tenant_id=v.tenant_id
 JOIN merchant_branches b ON b.id=i.branch_id AND b.merchant_id=m.id
 WHERE c.customer_id='ow-cart-customer' AND i.quantity=2;
 IF item_count <> 1 THEN RAISE EXCEPTION 'expected branch-scoped cart line'; END IF;
 BEGIN
  INSERT INTO customer_carts (id,tenant_id,customer_id,status,currency)
  VALUES ('ow-cart-b','platform','ow-cart-customer','active','SAR');
  RAISE EXCEPTION 'duplicate active customer cart unexpectedly accepted';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO customer_cart_items (id,tenant_id,cart_id,merchant_tenant_id,merchant_id,branch_id,product_variant_id,quantity)
  VALUES ('ow-cart-invalid','platform','ow-cart-a','ow-cart-merchant','ow-cart-merchant','ow-cart-branch','ow-cart-variant',100);
  RAISE EXCEPTION 'out-of-range cart quantity unexpectedly accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
ROLLBACK;
