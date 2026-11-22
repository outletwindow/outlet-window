\set ON_ERROR_STOP on
BEGIN;
INSERT INTO merchants(id,legal_name,display_name,country_code,status)
VALUES ('pickup-limit-ci-merchant','Pickup Limit LLC','Pickup Limit','SA','active');
INSERT INTO merchant_branches(id,merchant_id,display_name,city_code,status)
VALUES ('pickup-limit-ci-branch','pickup-limit-ci-merchant','Pickup Limit Branch','DMM','active');
INSERT INTO customer_orders(id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('pickup-limit-ci-order','platform','pickup-limit-ci-customer','pickup-limit-ci-order-key','confirmed','SAR',10000);
INSERT INTO merchant_suborders(id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('pickup-limit-ci-suborder','pickup-limit-ci-merchant','pickup-limit-ci-order','pickup-limit-ci-merchant','pickup-limit-ci-branch','ready_for_pickup',10000);
INSERT INTO courier_delivery_tasks(id,tenant_id,suborder_id,courier_id,status,idempotency_key)
VALUES ('pickup-limit-ci-task','pickup-limit-ci-merchant','pickup-limit-ci-suborder','pickup-limit-ci-courier','accepted','pickup-limit-ci-task-key');

INSERT INTO courier_pickup_code_issue_limits
(tenant_id,task_id,actor_id,window_started_at,issue_count,updated_at)
VALUES ('pickup-limit-ci-merchant','pickup-limit-ci-task','pickup-limit-ci-actor',now(),3,now());

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM courier_pickup_code_issue_limits
    WHERE tenant_id='pickup-limit-ci-merchant' AND task_id='pickup-limit-ci-task'
      AND actor_id='pickup-limit-ci-actor' AND issue_count=3
  ) THEN RAISE EXCEPTION 'pickup issuance throttle row missing'; END IF;

  BEGIN
    INSERT INTO courier_pickup_code_issue_limits
    (tenant_id,task_id,actor_id,window_started_at,issue_count,updated_at)
    VALUES ('pickup-limit-ci-merchant','pickup-limit-ci-task','pickup-limit-ci-actor',now(),1,now());
    RAISE EXCEPTION 'pickup issuance throttle key unexpectedly duplicated';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO courier_pickup_code_issue_limits
    (tenant_id,task_id,actor_id,window_started_at,issue_count,updated_at)
    VALUES ('pickup-limit-ci-merchant','missing-task','pickup-limit-ci-actor',now(),1,now());
    RAISE EXCEPTION 'pickup issuance throttle accepted an unknown task';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
ROLLBACK;
