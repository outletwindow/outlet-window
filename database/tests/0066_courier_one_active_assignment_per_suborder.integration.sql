\set ON_ERROR_STOP on
BEGIN;
INSERT INTO merchants(id,legal_name,display_name,country_code,status)
VALUES('courier-assignment-ci-merchant','Courier Assignment Test LLC','Courier Assignment Test','SA','active');
INSERT INTO merchant_branches(id,merchant_id,display_name,city_code,status)
VALUES('courier-assignment-ci-branch','courier-assignment-ci-merchant','Courier Assignment Branch','DMM','active');
INSERT INTO customer_orders(id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES('courier-assignment-ci-order','platform','courier-assignment-ci-customer','courier-assignment-ci-order-key','confirmed','SAR',10000);
INSERT INTO merchant_suborders(id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES('courier-assignment-ci-suborder','courier-assignment-ci-merchant','courier-assignment-ci-order','courier-assignment-ci-merchant','courier-assignment-ci-branch','ready_for_pickup',10000);

INSERT INTO courier_delivery_tasks(id,tenant_id,suborder_id,courier_id,status,idempotency_key)
VALUES('courier-assignment-ci-task-a','courier-assignment-ci-merchant','courier-assignment-ci-suborder','courier-a','accepted','courier-assignment-ci-key-a');

DO $$ BEGIN
 BEGIN
  INSERT INTO courier_delivery_tasks(id,tenant_id,suborder_id,courier_id,status,idempotency_key)
  VALUES('courier-assignment-ci-task-b','courier-assignment-ci-merchant','courier-assignment-ci-suborder','courier-b','accepted','courier-assignment-ci-key-b');
  RAISE EXCEPTION 'second active courier assignment unexpectedly accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;

UPDATE courier_delivery_tasks
SET status='failed', terminal_reason='test retry', version=version+1
WHERE id='courier-assignment-ci-task-a' AND tenant_id='courier-assignment-ci-merchant';

INSERT INTO courier_delivery_tasks(id,tenant_id,suborder_id,courier_id,status,idempotency_key)
VALUES('courier-assignment-ci-task-c','courier-assignment-ci-merchant','courier-assignment-ci-suborder','courier-c','accepted','courier-assignment-ci-key-c');
ROLLBACK;
