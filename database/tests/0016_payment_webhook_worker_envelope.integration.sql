\set ON_ERROR_STOP on
BEGIN;
INSERT INTO payment_provider_webhook_events
  (id,provider_key,provider_event_id,payload_sha256,status,event_type,normalized_status,provider_reference)
VALUES
  ('webhook-envelope-1','test-provider','evt-envelope-1',
   'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
   'received','payment.adjustment','succeeded','psp-ref-1');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_provider_webhook_events
    WHERE id='webhook-envelope-1' AND event_type='payment.adjustment'
      AND normalized_status='succeeded' AND provider_reference='psp-ref-1'
      AND attempt_count=0 AND next_attempt_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'normalized webhook envelope defaults were not persisted';
  END IF;

  BEGIN
    UPDATE payment_provider_webhook_events
      SET lease_owner='worker-without-expiry'
      WHERE id='webhook-envelope-1';
    RAISE EXCEPTION 'incomplete lease pair unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE payment_provider_webhook_events
      SET attempt_count=21
      WHERE id='webhook-envelope-1';
    RAISE EXCEPTION 'attempt count above configured bound unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE payment_provider_webhook_events
      SET normalized_status='paid-ish'
      WHERE id='webhook-envelope-1';
    RAISE EXCEPTION 'unknown normalized webhook status unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE payment_provider_webhook_events
    SET status='processing', lease_owner='worker-1',
        lease_expires_at=now()+interval '30 seconds', attempt_count=1
    WHERE id='webhook-envelope-1';
  IF NOT EXISTS (
    SELECT 1 FROM payment_provider_webhook_events
    WHERE id='webhook-envelope-1' AND status='processing'
      AND lease_owner='worker-1' AND lease_expires_at>now() AND attempt_count=1
  ) THEN
    RAISE EXCEPTION 'valid webhook processing lease was not persisted';
  END IF;
END $$;
ROLLBACK;
