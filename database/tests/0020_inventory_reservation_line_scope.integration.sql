\set ON_ERROR_STOP on
BEGIN;

INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES ('ci-scope-merchant','Scope Merchant LLC','Scope Merchant','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES
  ('ci-scope-branch-a','ci-scope-merchant','Scope Branch A','DMM','active'),
  ('ci-scope-branch-b','ci-scope-merchant','Scope Branch B','DMM','active');
INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('ci-scope-order','platform','ci-scope-customer','ci-scope-order-idem',
  'awaiting_payment','SAR',10000);
INSERT INTO merchant_suborders
  (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('ci-scope-suborder','ci-scope-merchant','ci-scope-order','ci-scope-merchant',
  'ci-scope-branch-a','awaiting_payment',10000);
INSERT INTO branch_inventory
  (merchant_id,branch_id,product_variant_id,sku,available_quantity,reserved_quantity,
   source,last_synced_at,availability_confidence)
VALUES
  ('ci-scope-merchant','ci-scope-branch-a','ci-scope-variant-a','SCOPE-A',0,1,'manual',now(),'high'),
  ('ci-scope-merchant','ci-scope-branch-b','ci-scope-variant-b','SCOPE-B',0,1,'manual',now(),'high');
INSERT INTO inventory_reservations
  (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,idempotency_key,status,requested_at)
VALUES ('ci-scope-reservation','ci-scope-merchant','ci-scope-order','ci-scope-suborder',
  'ci-scope-merchant','ci-scope-branch-a','ci-scope-reservation-idem','reserved',now());
INSERT INTO inventory_reservation_lines
  (reservation_id,merchant_id,branch_id,product_variant_id,sku,quantity)
VALUES ('ci-scope-reservation','ci-scope-merchant','ci-scope-branch-a','ci-scope-variant-a','SCOPE-A',1);

DO $$
BEGIN
  BEGIN
    INSERT INTO inventory_reservation_lines
      (reservation_id,merchant_id,branch_id,product_variant_id,sku,quantity)
    VALUES ('ci-scope-reservation','ci-scope-merchant','ci-scope-branch-b','ci-scope-variant-b','SCOPE-B',1);
    RAISE EXCEPTION 'cross-branch reservation line unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  IF (SELECT count(*) FROM inventory_reservation_lines
      WHERE reservation_id='ci-scope-reservation') <> 1 THEN
    RAISE EXCEPTION 'reservation line ledger changed after rejected cross-branch insert';
  END IF;
END $$;

ROLLBACK;
