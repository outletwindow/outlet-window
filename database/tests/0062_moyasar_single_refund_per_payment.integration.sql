\set ON_ERROR_STOP on
BEGIN;

INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES
  ('moyasar-once-order','platform','moyasar-once-customer',
   'moyasar-once-order-key','awaiting_payment','SAR',10000);
INSERT INTO verified_order_payment_captures
  (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,
   amount_minor,currency,captured_at,idempotency_key)
VALUES
  ('moyasar-once-capture','platform','moyasar-once-order','moyasar',
   'moyasar-once-capture-event','moyasar-once-payment',
   10000,'SAR',now(),'moyasar-once-capture-key');
INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
   status,consented_at,consent_actor_id,provider_key,expires_at)
VALUES
  ('moyasar-once-refund-a','platform','moyasar-once-order','moyasar-once-customer',
   'moyasar-once-refund-key-a','moyasar-once-quote-a','SAR','refund',
   2500,10000,7500,'provider_pending',now(),'moyasar-once-customer',
   'moyasar',now()+interval '5 minutes'),
  ('moyasar-once-refund-b','platform','moyasar-once-order','moyasar-once-customer',
   'moyasar-once-refund-key-b','moyasar-once-quote-b','SAR','refund',
   1000,7500,6500,'provider_pending',now(),'moyasar-once-customer',
   'moyasar',now()+interval '5 minutes');

INSERT INTO payment_adjustment_submission_outbox
  (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
VALUES
  ('moyasar-once-job-a','platform','moyasar-once-refund-a','moyasar',
   'moyasar-once-stable-key-a','queued');

UPDATE customer_payment_adjustments
SET status='provider_confirmed',provider_reference='moyasar-once-provider-ref',
    provider_confirmed_at=now(),updated_at=now()
WHERE id='moyasar-once-refund-a';

DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_refund_reservations
    WHERE adjustment_id='moyasar-once-refund-a' AND status='confirmed'
  ) THEN
    RAISE EXCEPTION 'first Moyasar refund was not confirmed in reservation history';
  END IF;

  BEGIN
    INSERT INTO payment_adjustment_submission_outbox
      (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
    VALUES
      ('moyasar-once-job-b','platform','moyasar-once-refund-b','moyasar',
       'moyasar-once-stable-key-b','queued');
    RAISE EXCEPTION 'second Moyasar refund unexpectedly reserved after payment was refunded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  IF EXISTS (
    SELECT 1 FROM payment_refund_reservations
    WHERE adjustment_id='moyasar-once-refund-b'
  ) THEN
    RAISE EXCEPTION 'rejected second refund unexpectedly created a reservation';
  END IF;
END
$test$;


-- The one-refund-per-payment rule is Moyasar-specific. Other providers may
-- support sequential partial refunds, so their existing balance reservation
-- behavior must remain unchanged.
INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES
  ('other-psp-refund-order','platform','other-psp-refund-customer',
   'other-psp-refund-order-key','awaiting_payment','SAR',10000);
INSERT INTO verified_order_payment_captures
  (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,
   amount_minor,currency,captured_at,idempotency_key)
VALUES
  ('other-psp-refund-capture','platform','other-psp-refund-order','other-psp',
   'other-psp-refund-capture-event','other-psp-refund-payment',
   10000,'SAR',now(),'other-psp-refund-capture-key');
INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
   status,consented_at,consent_actor_id,provider_key,expires_at)
VALUES
  ('other-psp-refund-a','platform','other-psp-refund-order','other-psp-refund-customer',
   'other-psp-refund-key-a','other-psp-refund-quote-a','SAR','refund',
   2500,10000,7500,'provider_pending',now(),'other-psp-refund-customer',
   'other-psp',now()+interval '5 minutes'),
  ('other-psp-refund-b','platform','other-psp-refund-order','other-psp-refund-customer',
   'other-psp-refund-key-b','other-psp-refund-quote-b','SAR','refund',
   1000,7500,6500,'provider_pending',now(),'other-psp-refund-customer',
   'other-psp',now()+interval '5 minutes');
INSERT INTO payment_adjustment_submission_outbox
  (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
VALUES
  ('other-psp-refund-job-a','platform','other-psp-refund-a','other-psp',
   'other-psp-refund-stable-key-a','queued');
UPDATE customer_payment_adjustments
SET status='provider_confirmed',provider_reference='other-psp-refund-provider-ref',
    provider_confirmed_at=now(),updated_at=now()
WHERE id='other-psp-refund-a';
INSERT INTO payment_adjustment_submission_outbox
  (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
VALUES
  ('other-psp-refund-job-b','platform','other-psp-refund-b','other-psp',
   'other-psp-refund-stable-key-b','queued');
DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_refund_reservations
    WHERE adjustment_id='other-psp-refund-a' AND status='confirmed'
  ) OR NOT EXISTS (
    SELECT 1 FROM payment_refund_reservations
    WHERE adjustment_id='other-psp-refund-b' AND status='reserved'
  ) THEN
    RAISE EXCEPTION 'Moyasar-specific refund guard incorrectly blocked another provider';
  END IF;
END
$test$;

ROLLBACK;
