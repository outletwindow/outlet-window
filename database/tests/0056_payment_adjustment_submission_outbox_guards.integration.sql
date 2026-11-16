\set ON_ERROR_STOP on
BEGIN;

INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES
  ('outbox-guard-order','platform','outbox-guard-customer',
   'outbox-guard-order-key','awaiting_payment','SAR',10000);

INSERT INTO verified_order_payment_captures
  (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,
   amount_minor,currency,captured_at,idempotency_key)
VALUES
  ('outbox-guard-capture','platform','outbox-guard-order','moyasar','evt-outbox-guard-capture','pay-outbox-guard-capture',
   10000,'SAR',now(),'capture-key-outbox-guard-capture');


INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
   status,consented_at,consent_actor_id,provider_key,expires_at)
VALUES
  ('outbox-guard-adjustment-1','platform','outbox-guard-order','outbox-guard-customer',
   'outbox-guard-adjustment-key-1','outbox-guard-quote-1','SAR','refund',
   1000,10000,9000,'provider_pending',now(),'outbox-guard-customer',
   'moyasar',now()+interval '5 minutes'),
  ('outbox-guard-adjustment-2','platform','outbox-guard-order','outbox-guard-customer',
   'outbox-guard-adjustment-key-2','outbox-guard-quote-2','SAR','refund',
   2000,10000,8000,'provider_pending',now(),'outbox-guard-customer',
   'moyasar',now()+interval '5 minutes');

INSERT INTO payment_adjustment_submission_outbox
  (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
VALUES
  ('outbox-guard-job-1','platform','outbox-guard-adjustment-1','moyasar',
   'outbox-guard-stable-key-1','queued');

DO $test$
BEGIN
  BEGIN
    INSERT INTO payment_adjustment_submission_outbox
      (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
    VALUES
      ('outbox-guard-job-wrong-provider','platform','outbox-guard-adjustment-2','tap',
       'outbox-guard-stable-key-wrong','queued');
    RAISE EXCEPTION 'mismatched provider identity unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE payment_adjustment_submission_outbox
      SET idempotency_key='outbox-guard-mutated-key'
      WHERE id='outbox-guard-job-1';
    RAISE EXCEPTION 'outbox idempotency key mutation unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE payment_adjustment_submission_outbox
      SET status='failed'
      WHERE id='outbox-guard-job-1';
    RAISE EXCEPTION 'invalid outbox state transition unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$test$;

UPDATE payment_adjustment_submission_outbox
SET status='processing',lease_owner='outbox-guard-worker',
    lease_expires_at=now()+interval '30 seconds',attempt_count=1
WHERE id='outbox-guard-job-1';

UPDATE payment_adjustment_submission_outbox
SET status='submitted',provider_reference='outbox-guard-provider-ref',
    completed_at=now(),lease_owner=NULL,lease_expires_at=NULL
WHERE id='outbox-guard-job-1';

DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_adjustment_submission_outbox
    WHERE id='outbox-guard-job-1' AND status='submitted'
      AND provider_reference='outbox-guard-provider-ref'
  ) THEN
    RAISE EXCEPTION 'valid outbox processing transition failed';
  END IF;
END
$test$;

ROLLBACK;
