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

  -- The same opaque reference from a different provider is a distinct identity.
  INSERT INTO customer_payment_adjustments
    (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
     adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
     status,consented_at,consent_actor_id,provider_key,provider_reference,expires_at)
  VALUES
    ('adjustment-ref-other-provider','platform','adjustment-ref-order','adjustment-ref-customer',
     'adjustment-ref-key-other-provider','adjustment-ref-quote-other-provider','SAR','additional_charge',
     3000,10000,13000,'provider_pending',now(),'adjustment-ref-customer',
     'tap','provider-ref-single-use',now()+interval '5 minutes');

  -- Legacy rows without provider_key still receive a deterministic single-use namespace.
  INSERT INTO customer_payment_adjustments
    (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
     adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
     status,consented_at,consent_actor_id,provider_reference,expires_at)
  VALUES
    ('adjustment-ref-legacy-1','platform','adjustment-ref-order','adjustment-ref-customer',
     'adjustment-ref-key-legacy-1','adjustment-ref-quote-legacy-1','SAR','additional_charge',
     4000,10000,14000,'provider_pending',now(),'adjustment-ref-customer',
     'legacy-provider-ref',now()+interval '5 minutes');

  BEGIN
    INSERT INTO customer_payment_adjustments
      (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
       adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
       status,consented_at,consent_actor_id,provider_reference,expires_at)
    VALUES
      ('adjustment-ref-legacy-2','platform','adjustment-ref-order','adjustment-ref-customer',
       'adjustment-ref-key-legacy-2','adjustment-ref-quote-legacy-2','SAR','additional_charge',
       5000,10000,15000,'provider_pending',now(),'adjustment-ref-customer',
       'legacy-provider-ref',now()+interval '5 minutes');
    RAISE EXCEPTION 'duplicate legacy provider reference unexpectedly accepted';
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
