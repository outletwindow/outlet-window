\set ON_ERROR_STOP on
BEGIN;

INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('ci-provider-receipt-order','platform','ci-provider-receipt-customer',
  'ci-provider-receipt-order-idem','awaiting_payment','SAR',10000);

INSERT INTO scheduled_task_inbox
  (id,tenant_id,order_id,idempotency_key,task_type,payload,status,available_at,provider_reference)
VALUES ('ci-provider-receipt-row','platform','ci-provider-receipt-order',
  'ci-provider-receipt-task-v1','merchant_preparation',
  '{"orderId":"ci-provider-receipt-order","idempotencyKey":"ci-provider-receipt-task-v1","taskType":"merchant_preparation"}'::jsonb,
  'pending',now(),'provider-job-123');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM scheduled_task_inbox
    WHERE id = 'ci-provider-receipt-row' AND provider_reference = 'provider-job-123'
  ) THEN
    RAISE EXCEPTION 'provider receipt was not persisted';
  END IF;

  BEGIN
    UPDATE scheduled_task_inbox SET provider_reference = '   '
    WHERE id = 'ci-provider-receipt-row';
    RAISE EXCEPTION 'blank provider receipt unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

ROLLBACK;
