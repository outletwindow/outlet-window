\set ON_ERROR_STOP on
BEGIN;

INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES
  ('moyasar-no-ref-order','platform','moyasar-no-ref-customer',
   'moyasar-no-ref-order-key','awaiting_payment','SAR',10000);

INSERT INTO verified_order_payment_captures
  (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,
   amount_minor,currency,captured_at,idempotency_key)
VALUES
  ('moyasar-no-ref-capture','platform','moyasar-no-ref-order','moyasar',
   'evt-moyasar-no-ref-capture','3fa85f64-5717-4562-b3fc-2c963f66afa6',
   10000,'SAR',now(),'moyasar-no-ref-capture-key');

INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
   status,consented_at,consent_actor_id,provider_key,expires_at)
VALUES
  ('moyasar-no-ref-adjustment','platform','moyasar-no-ref-order','moyasar-no-ref-customer',
   'moyasar-no-ref-adjustment-key','moyasar-no-ref-quote','SAR','refund',
   2500,10000,7500,'provider_pending',now(),'moyasar-no-ref-customer',
   'moyasar',now()+interval '5 minutes');

INSERT INTO payment_adjustment_submission_outbox
  (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
VALUES
  ('moyasar-no-ref-job','platform','moyasar-no-ref-adjustment','moyasar',
   'moyasar-no-ref-job-idempotency','queued');

UPDATE payment_adjustment_submission_outbox
SET status='processing',attempt_count=1,lease_owner='moyasar-test-worker',
    lease_expires_at=now()+interval '30 seconds'
WHERE id='moyasar-no-ref-job';

UPDATE payment_adjustment_submission_outbox
SET status='submitted',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL
WHERE id='moyasar-no-ref-job';

DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_adjustment_submission_outbox
    WHERE id='moyasar-no-ref-job' AND status='submitted'
      AND provider_reference IS NULL AND completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Moyasar accepted refund without synthetic reference was not persisted';
  END IF;
END
$test$;

INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES
  ('non-moyasar-no-ref-order','platform','non-moyasar-no-ref-customer',
   'non-moyasar-no-ref-order-key','awaiting_payment','SAR',10000);

INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
   status,consented_at,consent_actor_id,provider_key,expires_at)
VALUES
  ('non-moyasar-no-ref-adjustment','platform','non-moyasar-no-ref-order','non-moyasar-no-ref-customer',
   'non-moyasar-no-ref-adjustment-key','non-moyasar-no-ref-quote','SAR','additional_charge',
   1000,10000,11000,'provider_pending',now(),'non-moyasar-no-ref-customer',
   'other-provider',now()+interval '5 minutes');

INSERT INTO payment_adjustment_submission_outbox
  (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
VALUES
  ('non-moyasar-no-ref-job','platform','non-moyasar-no-ref-adjustment','other-provider',
   'non-moyasar-no-ref-job-idempotency','queued');

UPDATE payment_adjustment_submission_outbox
SET status='processing',attempt_count=1,lease_owner='other-provider-worker',
    lease_expires_at=now()+interval '30 seconds'
WHERE id='non-moyasar-no-ref-job';

DO $test$
BEGIN
  BEGIN
    UPDATE payment_adjustment_submission_outbox
    SET status='submitted',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL
    WHERE id='non-moyasar-no-ref-job';
    RAISE EXCEPTION 'non-Moyasar submission without provider reference unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$test$;

ROLLBACK;
