\set ON_ERROR_STOP on
BEGIN;

INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES
  ('adjustment-ref-order','platform','adjustment-ref-customer',
   'adjustment-ref-order-key','confirmed','SAR',10000);

INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
   status,consented_at,consent_actor_id,provider_key,provider_reference,expires_at)
VALUES
  ('adjustment-ref-1','platform','adjustment-ref-order','adjustment-ref-customer',
   'adjustment-ref-key-1','adjustment-ref-quote-1','SAR','additional_charge',
   1000,10000,11000,'provider_pending',now(),'adjustment-ref-customer',
   'moyasar','provider-ref-single-use',now()+interval '5 minutes');

DO $test$
BEGIN
  BEGIN
    INSERT INTO customer_payment_adjustments
      (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
       adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
       status,consented_at,consent_actor_id,provider_key,provider_reference,expires_at)
    VALUES
      ('adjustment-ref-2','platform','adjustment-ref-order','adjustment-ref-customer',
       'adjustment-ref-key-2','adjustment-ref-quote-2','SAR','additional_charge',
       2000,10000,12000,'provider_pending',now(),'adjustment-ref-customer',
       'moyasar','provider-ref-single-use',now()+interval '5 minutes');
    RAISE EXCEPTION 'duplicate provider reference unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname=current_schema()
      AND indexname='customer_payment_adjustments_provider_reference_once_idx'
  ) THEN
    RAISE EXCEPTION 'payment adjustment provider reference uniqueness index missing';
  END IF;
END
$test$;

ROLLBACK;
