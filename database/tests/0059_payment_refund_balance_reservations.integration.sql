\set ON_ERROR_STOP on
BEGIN;
INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES
  ('refund-reservation-order','platform','refund-reservation-customer',
   'refund-reservation-order-key','awaiting_payment','SAR',10000);
INSERT INTO verified_order_payment_captures
  (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,
   amount_minor,currency,captured_at,idempotency_key)
VALUES
  ('refund-reservation-capture','platform','refund-reservation-order','moyasar',
   'refund-reservation-capture-event','moyasar-refund-reservation-payment',
   10000,'SAR',now(),'refund-reservation-capture-key');
INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
   status,consented_at,consent_actor_id,provider_key,expires_at)
VALUES
  ('refund-reservation-a','platform','refund-reservation-order','refund-reservation-customer',
   'refund-reservation-key-a','refund-reservation-quote-a','SAR','refund',
   6500,10000,3500,'provider_pending',now(),'refund-reservation-customer',
   'moyasar',now()+interval '5 minutes'),
  ('refund-reservation-b','platform','refund-reservation-order','refund-reservation-customer',
   'refund-reservation-key-b','refund-reservation-quote-b','SAR','refund',
   4000,10000,6000,'provider_pending',now(),'refund-reservation-customer',
   'moyasar',now()+interval '5 minutes'),
  ('refund-reservation-c','platform','refund-reservation-order','refund-reservation-customer',
   'refund-reservation-key-c','refund-reservation-quote-c','SAR','refund',
   1000,10000,9000,'provider_pending',now(),'refund-reservation-customer',
   'moyasar',now()+interval '5 minutes');

INSERT INTO payment_adjustment_submission_outbox
  (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
VALUES
  ('refund-reservation-job-a','platform','refund-reservation-a','moyasar',
   'refund-reservation-stable-key-a','queued');

DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_refund_reservations
    WHERE adjustment_id='refund-reservation-a' AND amount_minor=6500
      AND status='reserved'
      AND original_payment_reference='moyasar-refund-reservation-payment'
  ) THEN
    RAISE EXCEPTION 'refund capacity was not reserved for original capture';
  END IF;

  BEGIN
    INSERT INTO payment_adjustment_submission_outbox
      (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
    VALUES
      ('refund-reservation-job-b-overflow','platform','refund-reservation-b','moyasar',
       'refund-reservation-overflow-key','queued');
    RAISE EXCEPTION 'concurrent refund reservations exceeded original capture';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$test$;

-- A caller cannot release reserved funds while the adjustment is still pending.
DO $test$
BEGIN
  BEGIN
    UPDATE payment_refund_reservations
    SET status='released'
    WHERE adjustment_id='refund-reservation-a';
    RAISE EXCEPTION 'pending refund reservation was manually released';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$test$;

-- A definitive provider rejection releases capacity; an ambiguous result does not.
UPDATE customer_payment_adjustments
SET status='provider_failed',updated_at=now()
WHERE id='refund-reservation-a';
DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_refund_reservations
    WHERE adjustment_id='refund-reservation-a' AND status='released'
  ) THEN
    RAISE EXCEPTION 'definitively rejected refund did not release capacity';
  END IF;
END
$test$;

INSERT INTO payment_adjustment_submission_outbox
  (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
VALUES
  ('refund-reservation-job-b','platform','refund-reservation-b','moyasar',
   'refund-reservation-stable-key-b','queued');
UPDATE payment_adjustment_submission_outbox
SET status='processing',attempt_count=1,lease_owner='refund-worker',
    lease_expires_at=now()+interval '30 seconds'
WHERE id='refund-reservation-job-b';
UPDATE payment_adjustment_submission_outbox
SET status='reconciliation_required',lease_owner=NULL,lease_expires_at=NULL,
    last_error_code='PROVIDER_OUTCOME_UNKNOWN'
WHERE id='refund-reservation-job-b';

DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_refund_reservations
    WHERE adjustment_id='refund-reservation-b' AND status='reserved'
  ) THEN
    RAISE EXCEPTION 'ambiguous refund outcome incorrectly released reserved capacity';
  END IF;
  BEGIN
    INSERT INTO payment_adjustment_submission_outbox
      (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
    VALUES
      ('refund-reservation-job-c-overflow','platform','refund-reservation-c','moyasar',
       'refund-reservation-overflow-key-c','queued');
    RAISE EXCEPTION 'ambiguous refund reservation was not counted against capture';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$test$;

UPDATE customer_payment_adjustments
SET status='provider_confirmed',provider_reference='moyasar-refund-b',
    provider_confirmed_at=now(),updated_at=now()
WHERE id='refund-reservation-b';
DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_refund_reservations
    WHERE adjustment_id='refund-reservation-b' AND status='confirmed'
  ) THEN
    RAISE EXCEPTION 'confirmed refund reservation was not retained as consumed capacity';
  END IF;
  BEGIN
    UPDATE payment_refund_reservations
    SET amount_minor=1
    WHERE adjustment_id='refund-reservation-b';
    RAISE EXCEPTION 'refund reservation amount unexpectedly mutable';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$test$;

-- Moyasar changes the payment to refunded after a partial refund and
-- accepts refund commands only from paid/captured. A second operation must
-- therefore be rejected before it reaches the provider.
DO $test$
BEGIN
  BEGIN
    INSERT INTO payment_adjustment_submission_outbox
      (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
    VALUES
      ('refund-reservation-job-c','platform','refund-reservation-c','moyasar',
       'refund-reservation-stable-key-c','queued');
    RAISE EXCEPTION 'second Moyasar refund unexpectedly reserved after confirmation';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM payment_refund_reservations
    WHERE adjustment_id='refund-reservation-c'
  ) THEN
    RAISE EXCEPTION 'rejected second refund unexpectedly created a reservation';
  END IF;
END
$test$;
ROLLBACK;
