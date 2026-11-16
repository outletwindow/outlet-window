\set ON_ERROR_STOP on
BEGIN;

INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES
  ('adjustment-outbox-order','platform','adjustment-outbox-customer',
   'adjustment-outbox-order-key','confirmed','SAR',10000);

INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
   status,consented_at,consent_actor_id,provider_key,expires_at)
VALUES
  ('adjustment-outbox-1','platform','adjustment-outbox-order','adjustment-outbox-customer',
   'adjustment-outbox-key-1','adjustment-outbox-quote-1','SAR','refund',
   2500,10000,7500,'provider_pending',now(),'adjustment-outbox-customer',
   'moyasar',now()+interval '5 minutes');

INSERT INTO payment_adjustment_submission_outbox
  (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
VALUES
  ('adjustment-outbox-job-1','platform','adjustment-outbox-1','moyasar',
   'stable-refund-idempotency-key-1','queued');

DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_adjustment_submission_outbox
    WHERE tenant_id='platform' AND adjustment_id='adjustment-outbox-1'
      AND status='queued' AND provider_reference IS NULL
  ) THEN
    RAISE EXCEPTION 'provider submission intent was not durably queued';
  END IF;

  BEGIN
    INSERT INTO payment_adjustment_submission_outbox
      (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
    VALUES
      ('adjustment-outbox-job-duplicate','platform','adjustment-outbox-1','moyasar',
       'stable-refund-idempotency-key-2','queued');
    RAISE EXCEPTION 'duplicate adjustment submission unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO payment_adjustment_submission_outbox
      (id,tenant_id,adjustment_id,provider_key,idempotency_key,status,lease_owner,lease_expires_at)
    VALUES
      ('adjustment-outbox-job-invalid','platform','adjustment-outbox-1','moyasar',
       'stable-refund-idempotency-key-3','queued','worker-1',now()+interval '30 seconds');
    RAISE EXCEPTION 'queued outbox row unexpectedly accepted a processing lease';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname=current_schema()
      AND indexname='payment_adjustment_submission_outbox_due_idx'
  ) THEN
    RAISE EXCEPTION 'payment adjustment outbox due index missing';
  END IF;
END
$test$;

INSERT INTO customer_payment_adjustment_events
  (id,tenant_id,adjustment_id,actor_id,event_type,occurred_at,snapshot)
VALUES
  ('adjustment-outbox-event-1','platform','adjustment-outbox-1','adjustment-outbox-customer',
   'provider_submission_queued',now(),'{"status":"provider_submission_queued"}'::jsonb);

ROLLBACK;
