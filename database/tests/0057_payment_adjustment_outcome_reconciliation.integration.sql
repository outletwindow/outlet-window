\set ON_ERROR_STOP on
BEGIN;
INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES
  ('outbox-unknown-order','platform','outbox-unknown-customer',
   'outbox-unknown-order-key','confirmed','SAR',10000);
INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
   status,consented_at,consent_actor_id,provider_key,expires_at)
VALUES
  ('outbox-unknown-adjustment','platform','outbox-unknown-order','outbox-unknown-customer',
   'outbox-unknown-adjustment-key','outbox-unknown-quote','SAR','refund',
   1000,10000,9000,'provider_pending',now(),'outbox-unknown-customer',
   'moyasar',now()+interval '5 minutes');
INSERT INTO payment_adjustment_submission_outbox
  (id,tenant_id,adjustment_id,provider_key,idempotency_key,status)
VALUES
  ('outbox-unknown-job','platform','outbox-unknown-adjustment','moyasar',
   'outbox-unknown-stable-key','queued');
UPDATE payment_adjustment_submission_outbox
SET status='processing',lease_owner='outbox-unknown-worker',
    lease_expires_at=now()+interval '30 seconds',attempt_count=1
WHERE id='outbox-unknown-job';
UPDATE payment_adjustment_submission_outbox
SET status='reconciliation_required',last_error_code='PAYMENT_PROVIDER_OUTCOME_UNKNOWN',
    lease_owner=NULL,lease_expires_at=NULL
WHERE id='outbox-unknown-job';
DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_adjustment_submission_outbox
    WHERE id='outbox-unknown-job' AND status='reconciliation_required'
      AND lease_owner IS NULL AND lease_expires_at IS NULL
  ) THEN
    RAISE EXCEPTION 'ambiguous provider outcome was not quarantined';
  END IF;
  BEGIN
    UPDATE payment_adjustment_submission_outbox
      SET status='queued'
      WHERE id='outbox-unknown-job';
    RAISE EXCEPTION 'reconciliation-required submission was unexpectedly requeued';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$test$;
ROLLBACK;
