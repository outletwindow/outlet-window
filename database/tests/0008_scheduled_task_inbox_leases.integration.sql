\set ON_ERROR_STOP on
BEGIN;

INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('ci-inbox-lease-order','platform','ci-inbox-lease-customer',
  'ci-inbox-lease-order-idem','awaiting_payment','SAR',10000);

INSERT INTO scheduled_task_inbox
  (id,tenant_id,order_id,idempotency_key,task_type,payload,status,available_at)
VALUES ('ci-inbox-lease-row','platform','ci-inbox-lease-order',
  'ci-inbox-lease-task-v1','merchant_preparation',
  '{"orderId":"ci-inbox-lease-order","idempotencyKey":"ci-inbox-lease-task-v1","taskType":"merchant_preparation"}'::jsonb,
  'pending',now());

DO $$
BEGIN
  BEGIN
    INSERT INTO scheduled_task_inbox
      (id,tenant_id,order_id,idempotency_key,task_type,payload,status,available_at)
    VALUES ('ci-inbox-no-lease','platform','ci-inbox-lease-order',
      'ci-inbox-no-lease-task-v1','merchant_preparation','{}'::jsonb,'processing',now());
    RAISE EXCEPTION 'processing inbox row without a lease unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE scheduled_task_inbox SET status = 'completed'
    WHERE id = 'ci-inbox-lease-row';
    RAISE EXCEPTION 'completed inbox row without processed_at unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

ROLLBACK;
