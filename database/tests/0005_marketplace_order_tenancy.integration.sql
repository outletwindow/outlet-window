\\set ON_ERROR_STOP on
BEGIN;
INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES ('multi-ci-merchant-a','Merchant A LLC','Merchant A','SA','active'),
       ('multi-ci-merchant-b','Merchant B LLC','Merchant B','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('multi-ci-branch-a','multi-ci-merchant-a','Branch A','JUB','active'),
       ('multi-ci-branch-b','multi-ci-merchant-b','Branch B','JUB','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('multi-ci-parent','platform','multi-ci-customer','multi-idempotency-0001','pending_validation','SAR',50000);
INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('multi-ci-sub-a','multi-ci-merchant-a','multi-ci-parent','multi-ci-merchant-a','multi-ci-branch-a','pending_validation',20000),
       ('multi-ci-sub-b','multi-ci-merchant-b','multi-ci-parent','multi-ci-merchant-b','multi-ci-branch-b','pending_validation',30000);
DO $$
BEGIN
 IF (SELECT count(*) FROM merchant_suborders WHERE order_id='multi-ci-parent') <> 2 THEN
   RAISE EXCEPTION 'multi-merchant parent order did not retain both merchant suborders';
 END IF;
 IF (SELECT count(DISTINCT tenant_id) FROM merchant_suborders WHERE order_id='multi-ci-parent') <> 2 THEN
   RAISE EXCEPTION 'merchant suborders were not isolated by merchant tenant';
 END IF;
 BEGIN
   INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
   VALUES ('multi-ci-invalid','multi-ci-merchant-a','multi-ci-parent','multi-ci-merchant-b','multi-ci-branch-b','pending_validation',1);
   RAISE EXCEPTION 'cross-merchant tenant assignment unexpectedly accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 BEGIN
   INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
   VALUES ('multi-ci-orphan','multi-ci-merchant-a','missing-parent','multi-ci-merchant-a','multi-ci-branch-a','pending_validation',1);
   RAISE EXCEPTION 'orphan suborder unexpectedly accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
END $$;
ROLLBACK;
