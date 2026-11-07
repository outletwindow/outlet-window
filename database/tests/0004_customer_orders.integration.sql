\set ON_ERROR_STOP on
BEGIN;
INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES ('order-ci-merchant','Outlet Test LLC','Outlet Test','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('order-ci-branch','order-ci-merchant','Jubail Branch','JUB','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('order-ci-parent','tenant-ci','customer-ci','idempotency-key-0001','pending_validation','SAR',25000);
INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('order-ci-sub','tenant-ci','order-ci-parent','order-ci-merchant','order-ci-branch','pending_validation',25000);
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM merchant_suborders WHERE tenant_id='tenant-ci' AND order_id='order-ci-parent') THEN
   RAISE EXCEPTION 'suborder missing';
 END IF;
 IF EXISTS (SELECT 1 FROM customer_orders WHERE tenant_id='other-tenant' AND id='order-ci-parent') THEN
   RAISE EXCEPTION 'cross-tenant parent order visible';
 END IF;
 BEGIN
   INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
   VALUES ('order-ci-duplicate','tenant-ci','customer-ci','idempotency-key-0001','pending_validation','SAR',25000);
   RAISE EXCEPTION 'idempotency uniqueness unexpectedly allowed duplicate';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 BEGIN
   INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
   VALUES ('order-ci-cross','other-tenant','order-ci-parent','order-ci-merchant','order-ci-branch','pending_validation',100);
   RAISE EXCEPTION 'cross-tenant suborder parent unexpectedly accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
END $$;
ROLLBACK;
