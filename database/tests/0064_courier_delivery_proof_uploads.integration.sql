\\set ON_ERROR_STOP on
BEGIN;
INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES ('courier-proof-ci-merchant','Courier Proof Test LLC','Courier Proof Test','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('courier-proof-ci-branch','courier-proof-ci-merchant','Courier Proof Branch','JUB','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('courier-proof-ci-order','platform','courier-proof-ci-customer','courier-proof-ci-order-key','confirmed','SAR',10000);
INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('courier-proof-ci-suborder','courier-proof-ci-merchant','courier-proof-ci-order',
  'courier-proof-ci-merchant','courier-proof-ci-branch','ready_for_pickup',10000);
INSERT INTO courier_delivery_tasks
  (id,tenant_id,suborder_id,courier_id,status,idempotency_key)
VALUES
  ('courier-proof-ci-task','courier-proof-ci-merchant','courier-proof-ci-suborder',
   'courier-proof-ci-user','arrived_at_dropoff','courier-proof-task-key-001'),
  ('courier-proof-ci-other-task','courier-proof-ci-merchant','courier-proof-ci-suborder',
   'courier-proof-ci-other-user','arrived_at_dropoff','courier-proof-task-key-002');
INSERT INTO courier_delivery_evidence
  (id,tenant_id,task_id,evidence_type,verification_method,object_key,content_sha256,verified_by,verified_at)
VALUES
  ('courier-proof-ci-evidence','courier-proof-ci-merchant','courier-proof-ci-task',
   'proof_of_delivery','private_object_sha256','courier-delivery-proof/verified',
   repeat('a',64),'courier-proof-ci-user',now()),
  ('courier-proof-ci-other-evidence','courier-proof-ci-merchant','courier-proof-ci-other-task',
   'proof_of_delivery','private_object_sha256','courier-delivery-proof/other',
   repeat('b',64),'courier-proof-ci-other-user',now());

INSERT INTO courier_delivery_proof_uploads
  (id,tenant_id,task_id,courier_id,object_key,content_type,expected_content_length,
   expected_content_sha256,expires_at)
VALUES
  ('courier-proof-ci-upload','courier-proof-ci-merchant','courier-proof-ci-task',
   'courier-proof-ci-user','courier-delivery-proof/pending','image/jpeg',1024,
   repeat('c',64),now()+interval '5 minutes');

-- A verified upload must reference proof evidence for the exact same tenant and task.
INSERT INTO courier_delivery_proof_uploads
  (id,tenant_id,task_id,courier_id,object_key,content_type,expected_content_length,
   expected_content_sha256,status,expires_at,verified_evidence_id,completed_at)
VALUES
  ('courier-proof-ci-verified','courier-proof-ci-merchant','courier-proof-ci-task',
   'courier-proof-ci-user','courier-delivery-proof/verified-upload','image/png',2048,
   repeat('a',64),'verified',now()+interval '5 minutes',
   'courier-proof-ci-evidence',now());

DO $$
BEGIN
  BEGIN
    INSERT INTO courier_delivery_proof_uploads
      (id,tenant_id,task_id,courier_id,object_key,content_type,expected_content_length,
       expected_content_sha256,expires_at)
    VALUES ('courier-proof-ci-wrong-courier','courier-proof-ci-merchant','courier-proof-ci-task',
      'courier-proof-ci-other-user','courier-delivery-proof/wrong-courier','image/jpeg',100,
      repeat('d',64),now()+interval '5 minutes');
    RAISE EXCEPTION 'proof upload for a non-assigned courier unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO courier_delivery_proof_uploads
      (id,tenant_id,task_id,courier_id,object_key,content_type,expected_content_length,
       expected_content_sha256,status,expires_at,verified_evidence_id,completed_at)
    VALUES ('courier-proof-ci-cross-task-evidence','courier-proof-ci-merchant','courier-proof-ci-task',
      'courier-proof-ci-user','courier-delivery-proof/cross-task','image/jpeg',100,
      repeat('e',64),'verified',now()+interval '5 minutes',
      'courier-proof-ci-other-evidence',now());
    RAISE EXCEPTION 'cross-task proof evidence unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO courier_delivery_proof_uploads
      (id,tenant_id,task_id,courier_id,object_key,content_type,expected_content_length,
       expected_content_sha256,status,expires_at,verified_evidence_id,completed_at)
    VALUES ('courier-proof-ci-orphan-evidence','courier-proof-ci-merchant','courier-proof-ci-task',
      'courier-proof-ci-user','courier-delivery-proof/orphan','image/jpeg',100,
      repeat('f',64),'verified',now()+interval '5 minutes','missing-evidence-id',now());
    RAISE EXCEPTION 'orphan proof evidence unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO courier_delivery_proof_uploads
      (id,tenant_id,task_id,courier_id,object_key,content_type,expected_content_length,
       expected_content_sha256,expires_at,created_at)
    VALUES ('courier-proof-ci-expired-at-create','courier-proof-ci-merchant','courier-proof-ci-task',
      'courier-proof-ci-user','courier-delivery-proof/expired','image/jpeg',100,
      repeat('1',64),now()-interval '1 minute',now());
    RAISE EXCEPTION 'already expired proof upload unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO courier_delivery_proof_uploads
      (id,tenant_id,task_id,courier_id,object_key,content_type,expected_content_length,
       expected_content_sha256,expires_at)
    VALUES ('courier-proof-ci-too-large','courier-proof-ci-merchant','courier-proof-ci-task',
      'courier-proof-ci-user','courier-delivery-proof/too-large','image/jpeg',10485761,
      repeat('2',64),now()+interval '5 minutes');
    RAISE EXCEPTION 'oversized proof upload unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO courier_delivery_proof_uploads
      (id,tenant_id,task_id,courier_id,object_key,content_type,expected_content_length,
       expected_content_sha256,expires_at)
    VALUES ('courier-proof-ci-bad-hash','courier-proof-ci-merchant','courier-proof-ci-task',
      'courier-proof-ci-user','courier-delivery-proof/bad-hash','image/jpeg',100,
      'not-a-sha256',now()+interval '5 minutes');
    RAISE EXCEPTION 'invalid proof checksum unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO courier_delivery_proof_uploads
      (id,tenant_id,task_id,courier_id,object_key,content_type,expected_content_length,
       expected_content_sha256,status,expires_at,verified_evidence_id)
    VALUES ('courier-proof-ci-incomplete-verified','courier-proof-ci-merchant','courier-proof-ci-task',
      'courier-proof-ci-user','courier-delivery-proof/incomplete','image/jpeg',100,
      repeat('3',64),'verified',now()+interval '5 minutes','courier-proof-ci-evidence');
    RAISE EXCEPTION 'verified proof without completion timestamp unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
