\set ON_ERROR_STOP on
BEGIN;
INSERT INTO merchants(id,legal_name,display_name,country_code,status)
VALUES ('pickup-audit-ci-merchant','Pickup Audit LLC','Pickup Audit','SA','active');
INSERT INTO merchant_branches(id,merchant_id,display_name,city_code,status)
VALUES ('pickup-audit-ci-branch','pickup-audit-ci-merchant','Pickup Audit Branch','DMM','active');
INSERT INTO customer_orders(id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('pickup-audit-ci-order','platform','pickup-audit-ci-customer','pickup-audit-ci-order-key','confirmed','SAR',10000);
INSERT INTO merchant_suborders(id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('pickup-audit-ci-suborder','pickup-audit-ci-merchant','pickup-audit-ci-order','pickup-audit-ci-merchant','pickup-audit-ci-branch','ready_for_pickup',10000);
INSERT INTO courier_delivery_tasks(id,tenant_id,suborder_id,courier_id,status,idempotency_key)
VALUES ('pickup-audit-ci-task','pickup-audit-ci-merchant','pickup-audit-ci-suborder','pickup-audit-ci-courier','accepted','pickup-audit-ci-task-key');
INSERT INTO courier_pickup_code_credentials(id,tenant_id,task_id,code_digest,expires_at,max_attempts)
VALUES ('pickup-audit-ci-credential','pickup-audit-ci-merchant','pickup-audit-ci-task',repeat('a',64),now()+interval '15 minutes',5);
INSERT INTO courier_pickup_code_issuance_audit
(id,tenant_id,task_id,credential_id,merchant_id,branch_id,order_id,suborder_id,actor_id,actor_role,action,occurred_at)
VALUES
('pickup-audit-ci-event','pickup-audit-ci-merchant','pickup-audit-ci-task','pickup-audit-ci-credential',
 'pickup-audit-ci-merchant','pickup-audit-ci-branch','pickup-audit-ci-order','pickup-audit-ci-suborder',
 'pickup-audit-ci-employee','merchant_employee','issued',now());

DO $$
BEGIN
  BEGIN
    UPDATE courier_pickup_code_issuance_audit
      SET action='reissued' WHERE id='pickup-audit-ci-event';
    RAISE EXCEPTION 'pickup code issuance audit unexpectedly mutable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'courier_pickup_code_issuance_audit is append-only' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM courier_pickup_code_issuance_audit WHERE id='pickup-audit-ci-event';
    RAISE EXCEPTION 'pickup code issuance audit unexpectedly deletable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'courier_pickup_code_issuance_audit is append-only' THEN RAISE; END IF;
  END;
  BEGIN
    TRUNCATE courier_pickup_code_issuance_audit;
    RAISE EXCEPTION 'pickup code issuance audit unexpectedly truncatable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'courier_pickup_code_issuance_audit is append-only' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM courier_pickup_code_issuance_audit
    WHERE id='pickup-audit-ci-event' AND action='issued'
      AND credential_id='pickup-audit-ci-credential'
  ) THEN
    RAISE EXCEPTION 'pickup code issuance audit row missing or changed';
  END IF;
END $$;
ROLLBACK;
