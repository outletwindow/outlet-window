\set ON_ERROR_STOP on
BEGIN;
INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES ('courier-ci-merchant','Courier Test LLC','Courier Test','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('courier-ci-branch','courier-ci-merchant','Courier Branch','JUB','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('courier-ci-order','platform','courier-ci-customer','courier-ci-order-key','confirmed','SAR',10000);
INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('courier-ci-suborder','courier-ci-merchant','courier-ci-order','courier-ci-merchant','courier-ci-branch','ready_for_pickup',10000);
INSERT INTO courier_delivery_tasks
  (id,tenant_id,suborder_id,courier_id,status,idempotency_key)
VALUES
  ('courier-ci-task','courier-ci-merchant','courier-ci-suborder','courier-ci-user','offered','courier-task-key-001');
INSERT INTO courier_pickup_code_credentials
  (id,tenant_id,task_id,code_digest,expires_at)
VALUES
  ('courier-ci-code','courier-ci-merchant','courier-ci-task',repeat('a',64),now()+interval '10 minutes');
DO $$
BEGIN
  BEGIN
    INSERT INTO courier_pickup_code_credentials
      (id,tenant_id,task_id,code_digest,expires_at)
    VALUES ('courier-ci-code-duplicate','courier-ci-merchant','courier-ci-task',
      repeat('b',64),now()+interval '10 minutes');
    RAISE EXCEPTION 'second active pickup credential unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO courier_delivery_tasks
      (id,tenant_id,suborder_id,courier_id,status,idempotency_key)
    VALUES ('courier-ci-cross-tenant','platform','courier-ci-suborder',
      'courier-ci-user','offered','courier-task-key-002');
    RAISE EXCEPTION 'cross-tenant courier task unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
INSERT INTO courier_delivery_evidence
  (id,tenant_id,task_id,evidence_type,verification_method,verified_by,verified_at)
VALUES
  ('courier-ci-pickup-evidence','courier-ci-merchant','courier-ci-task',
   'pickup_code_verification','server_digest_match','courier-ci-user',now());
INSERT INTO courier_delivery_task_events
  (id,tenant_id,task_id,sequence,from_status,to_status,actor_id,actor_role,occurred_at)
VALUES
  ('courier-ci-event-1','courier-ci-merchant','courier-ci-task',1,NULL,'offered',
   'courier-ci-dispatcher','dispatcher',now());
DO $$
BEGIN
  BEGIN
    UPDATE courier_delivery_evidence SET verified_by='tampered'
    WHERE id='courier-ci-pickup-evidence';
    RAISE EXCEPTION 'courier evidence unexpectedly mutable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'courier_delivery_evidence is append-only' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM courier_delivery_task_events WHERE id='courier-ci-event-1';
    RAISE EXCEPTION 'courier task event unexpectedly deletable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'courier_delivery_task_events are append-only' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
