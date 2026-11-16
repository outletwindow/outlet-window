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

ROLLBACK;
