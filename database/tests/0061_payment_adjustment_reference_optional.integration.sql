\set ON_ERROR_STOP on
BEGIN;

INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES
  ('optional-ref-order','platform','optional-ref-customer',
   'optional-ref-order-key','awaiting_payment','SAR',10000);

INSERT INTO verified_order_payment_captures
  (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,
   amount_minor,currency,captured_at,idempotency_key)
VALUES
  ('optional-ref-capture','platform','optional-ref-order','moyasar',
   'optional-ref-capture-event','3fa85f64-5717-4562-b3fc-2c963f66afa6',
   10000,'SAR',now(),'optional-ref-capture-key');

INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
   status,consented_at,consent_actor_id,provider_key,expires_at)
VALUES
  ('optional-ref-adjustment','platform','optional-ref-order','optional-ref-customer',
   'optional-ref-adjustment-key','optional-ref-quote','SAR','refund',
   2500,10000,7500,'provider_pending',now(),'optional-ref-customer',
   'moyasar',now()+interval '5 minutes');

INSERT INTO payment_adjustment_submission_outbox
  (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
VALUES
  ('optional-ref-submission','platform','optional-ref-adjustment','moyasar',
   'optional-ref-submission-key','queued');

UPDATE payment_adjustment_submission_outbox
SET status='processing',attempt_count=1,lease_owner='optional-ref-worker',
    lease_expires_at=now()+interval '30 seconds'
WHERE id='optional-ref-submission';

UPDATE payment_adjustment_submission_outbox
SET status='submitted',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL
WHERE id='optional-ref-submission';

DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_adjustment_submission_outbox
    WHERE id='optional-ref-submission' AND status='submitted'
      AND provider_reference IS NULL AND completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'submitted refund without a unique PSP reference was not persisted';
  END IF;
END
$test$;

ROLLBACK;
