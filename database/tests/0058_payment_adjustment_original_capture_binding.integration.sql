\set ON_ERROR_STOP on
BEGIN;
INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES
  ('original-capture-binding-order','platform','original-capture-binding-customer',
   'original-capture-binding-order-key','awaiting_payment','SAR',10000);
INSERT INTO verified_order_payment_captures
  (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,
   amount_minor,currency,captured_at,idempotency_key)
VALUES
  ('original-capture-binding-capture','platform','original-capture-binding-order',
   'moyasar','original-capture-binding-event','moyasar-payment-original-123',
   10000,'SAR',now(),'original-capture-binding-capture-key');
INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
   status,consented_at,consent_actor_id,provider_key,expires_at)
VALUES
  ('original-capture-binding-refund','platform','original-capture-binding-order',
   'original-capture-binding-customer','original-capture-binding-refund-key',
   'original-capture-binding-quote','SAR','refund',2500,10000,7500,
   'provider_pending',now(),'original-capture-binding-customer','moyasar',
   now()+interval '5 minutes'),
  ('original-capture-binding-mismatch','platform','original-capture-binding-order',
   'original-capture-binding-customer','original-capture-binding-mismatch-key',
   'original-capture-binding-quote-2','SAR','refund',1500,10000,8500,
   'provider_pending',now(),'original-capture-binding-customer','tap',
   now()+interval '5 minutes');
INSERT INTO payment_adjustment_submission_outbox
  (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
VALUES
  ('original-capture-binding-job','platform','original-capture-binding-refund',
   'moyasar','original-capture-binding-stable-key','queued');
DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_adjustment_submission_outbox
    WHERE id='original-capture-binding-job'
      AND original_payment_reference='moyasar-payment-original-123'
  ) THEN
    RAISE EXCEPTION 'refund submission was not bound to original provider capture';
  END IF;
  BEGIN
    INSERT INTO payment_adjustment_submission_outbox
      (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
    VALUES
      ('original-capture-binding-wrong-provider','platform',
       'original-capture-binding-mismatch','tap',
       'original-capture-binding-wrong-key','queued');
    RAISE EXCEPTION 'refund with mismatched provider capture unexpectedly queued';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    UPDATE payment_adjustment_submission_outbox
      SET original_payment_reference='forged-original-payment'
      WHERE id='original-capture-binding-job';
    RAISE EXCEPTION 'original payment reference mutation unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$test$;
ROLLBACK;
