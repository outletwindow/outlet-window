\set ON_ERROR_STOP on
BEGIN;

INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES
  ('ci-scheduled-outbox-order','platform','ci-scheduled-outbox-customer',
   'ci-scheduled-outbox-idempotency','awaiting_payment','SAR',10000);

INSERT INTO scheduled_task_outbox
  (id,tenant_id,order_id,idempotency_key,task_type,execute_at,status,attempt_count,
   created_at,updated_at,available_at,payload)
VALUES
  ('ci-scheduled-outbox-row','platform','ci-scheduled-outbox-order',
   'ci-scheduled-outbox-task-v1','merchant_reservation','2026-11-08T10:00:00Z',
   'pending',0,now(),now(),now(),
   '{"orderId":"ci-scheduled-outbox-order","taskType":"merchant_reservation"}'::jsonb);

INSERT INTO scheduled_task_inbox
  (id,tenant_id,order_id,idempotency_key,task_type,payload)
VALUES
  ('ci-scheduled-outbox-task-v1','platform','ci-scheduled-outbox-order',
   'ci-scheduled-outbox-task-v1','merchant_reservation',
   '{"orderId":"ci-scheduled-outbox-order","taskType":"merchant_reservation"}'::jsonb);

DO $
BEGIN
  BEGIN
    INSERT INTO scheduled_task_inbox (id,tenant_id,order_id,idempotency_key,task_type,payload)
    VALUES ('ci-scheduled-inbox-duplicate','platform','ci-scheduled-outbox-order',
      'ci-scheduled-outbox-task-v1','merchant_reservation','{}'::jsonb);
    RAISE EXCEPTION 'duplicate inbox idempotency key unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO scheduled_task_outbox
      (id,tenant_id,order_id,idempotency_key,task_type,execute_at,status,attempt_count,
       created_at,updated_at,available_at,payload)
    VALUES
      ('ci-scheduled-outbox-duplicate','platform','ci-scheduled-outbox-order',
       'ci-scheduled-outbox-task-v1','merchant_reservation',now(),
       'pending',0,now(),now(),now(),'{}'::jsonb);
    RAISE EXCEPTION 'duplicate outbox idempotency key unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO scheduled_task_outbox
      (id,tenant_id,order_id,idempotency_key,task_type,execute_at,status,attempt_count,
       created_at,updated_at,available_at,payload)
    VALUES
      ('ci-scheduled-outbox-wrong-tenant','another-tenant','ci-scheduled-outbox-order',
       'ci-scheduled-outbox-wrong-tenant-key','merchant_reservation',now(),
       'pending',0,now(),now(),now(),'{}'::jsonb);
    RAISE EXCEPTION 'cross-tenant outbox row unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO scheduled_task_outbox
      (id,tenant_id,order_id,idempotency_key,task_type,execute_at,status,attempt_count,
       created_at,updated_at,available_at,payload)
    VALUES
      ('ci-scheduled-outbox-invalid-lease','platform','ci-scheduled-outbox-order',
       'ci-scheduled-outbox-invalid-lease-key','merchant_reservation',now(),
       'leased',1,now(),now(),now(),'{}'::jsonb);
    RAISE EXCEPTION 'lease without a token unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

ROLLBACK;
