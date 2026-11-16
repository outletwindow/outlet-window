\set ON_ERROR_STOP on
BEGIN;

INSERT INTO payment_provider_webhook_events
  (id,provider_key,provider_event_id,payload_sha256,status,event_type,
   provider_reference,received_at,processed_at,failure_code)
VALUES
  ('refund-webhook-reconciliation-test','moyasar','refund-webhook-reconciliation-event',
   repeat('a',64),'reconciliation_required','payment_refunded',
   '3fa85f64-5717-4562-b3fc-2c963f66afa6',now(),NULL,
   'REFUND_CUMULATIVE_TOTAL_OR_BINDING_MISMATCH');

DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_provider_webhook_events
    WHERE id='refund-webhook-reconciliation-test'
      AND status='reconciliation_required'
      AND processed_at IS NULL
      AND failure_code='REFUND_CUMULATIVE_TOTAL_OR_BINDING_MISMATCH'
  ) THEN
    RAISE EXCEPTION 'refund webhook reconciliation quarantine state was not persisted';
  END IF;

  IF EXISTS (
    SELECT 1 FROM payment_provider_webhook_events
    WHERE id='refund-webhook-reconciliation-test'
      AND (status='received' OR (status='processing' AND lease_expires_at <= now()))
  ) THEN
    RAISE EXCEPTION 'quarantined refund webhook is eligible for generic worker retry';
  END IF;
END
$test$;

ROLLBACK;
