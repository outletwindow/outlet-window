\set ON_ERROR_STOP on
BEGIN;

INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES ('ci-inventory-merchant','Inventory Merchant LLC','Inventory Merchant','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('ci-inventory-branch','ci-inventory-merchant','Inventory Branch','JUB','active');
INSERT INTO tenant_integrations
  (id,tenant_id,family,provider_key,display_name,status,capabilities,created_at,updated_at)
VALUES ('ci-inventory-integration','ci-inventory-merchant','commerce','ci-inventory','Inventory Test Catalog','connected','["catalog.read"]',now(),now());
INSERT INTO commerce_catalog_products
  (id,tenant_id,integration_id,provider_key,external_product_id,canonical_url,title,
   currency,price_minor,source_type,source_captured_at,source_content_sha256,published_at,publication_updated_at)
VALUES ('ci-inventory-product','ci-inventory-merchant','ci-inventory-integration','ci-inventory',
   'inventory-product','https://inventory.example.test/product','Inventory Test Product',
   'SAR',10000,'manual',now(),repeat('c',64),now(),now());
INSERT INTO commerce_catalog_variants
  (id,tenant_id,product_id,external_variant_id,sku,currency,price_minor,availability)
VALUES ('ci-inventory-variant','ci-inventory-merchant','ci-inventory-product',
   'ci-inventory-variant','CI-SKU-001','SAR',10000,'in_stock');
INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('ci-inventory-order','platform','ci-inventory-customer',
  'ci-inventory-order-idem','awaiting_payment','SAR',10000);
INSERT INTO merchant_suborders
  (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('ci-inventory-suborder','ci-inventory-merchant','ci-inventory-order',
  'ci-inventory-merchant','ci-inventory-branch','awaiting_payment',10000);
INSERT INTO customer_order_items
  (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,product_variant_id,
   sku,quantity,unit_price_minor,currency)
VALUES ('ci-inventory-item','ci-inventory-merchant','ci-inventory-order',
  'ci-inventory-suborder','ci-inventory-merchant','ci-inventory-branch',
  'ci-inventory-variant','CI-SKU-001',1,10000,'SAR');
INSERT INTO branch_inventory
  (merchant_id,branch_id,product_variant_id,sku,available_quantity,reserved_quantity,
   source,last_synced_at,availability_confidence)
VALUES ('ci-inventory-merchant','ci-inventory-branch','ci-inventory-variant',
  'CI-SKU-001',1,1,'merchant_portal',now(),'high');
INSERT INTO inventory_reservations
  (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,idempotency_key,
   status,requested_at)
VALUES ('ci-inventory-reservation','ci-inventory-merchant','ci-inventory-order',
  'ci-inventory-suborder','ci-inventory-merchant','ci-inventory-branch',
  'ci-inventory-reservation-v1','reserved',now());
INSERT INTO inventory_reservation_lines
  (reservation_id,merchant_id,branch_id,product_variant_id,sku,quantity)
VALUES ('ci-inventory-reservation','ci-inventory-merchant','ci-inventory-branch',
  'ci-inventory-variant','CI-SKU-001',1);

DO $$
BEGIN
  BEGIN
    INSERT INTO branch_inventory
      (merchant_id,branch_id,product_variant_id,sku,available_quantity,reserved_quantity,
       source,last_synced_at,availability_confidence)
    VALUES ('ci-inventory-merchant','ci-inventory-branch','ci-inventory-negative',
      'CI-SKU-NEG',-1,0,'merchant_portal',now(),'high');
    RAISE EXCEPTION 'negative available inventory unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO inventory_reservations
      (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,idempotency_key,
       status,requested_at)
    VALUES ('ci-inventory-wrong-suborder','ci-inventory-merchant','ci-inventory-order',
      'missing-suborder','ci-inventory-merchant','ci-inventory-branch',
      'ci-inventory-wrong-suborder-v1','reserved',now());
    RAISE EXCEPTION 'reservation with unknown suborder unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO inventory_reservations
      (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,idempotency_key,
       status,requested_at)
    VALUES ('ci-inventory-consumed-no-proof','ci-inventory-merchant','ci-inventory-order',
      'ci-inventory-suborder','ci-inventory-merchant','ci-inventory-branch',
      'ci-inventory-consumed-no-proof-v1','consumed',now());
    RAISE EXCEPTION 'consumed reservation without handover proof unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO inventory_reservations
      (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,idempotency_key,
       status,requested_at)
    VALUES ('ci-inventory-duplicate-idem','ci-inventory-merchant','ci-inventory-order',
      'ci-inventory-suborder','ci-inventory-merchant','ci-inventory-branch',
      'ci-inventory-reservation-v1','reserved',now());
    RAISE EXCEPTION 'duplicate reservation idempotency key unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

ROLLBACK;
