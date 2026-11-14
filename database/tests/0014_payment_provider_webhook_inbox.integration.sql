\set ON_ERROR_STOP on
BEGIN;
INSERT INTO payment_provider_webhook_events
  (id,provider_key,provider_event_id,payload_sha256,status,adjustment_id)
VALUES
  ('webhook-1','test-provider','evt-unique-1',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   'received',NULL);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payment_provider_webhook_events
    WHERE provider_key='test-provider' AND provider_event_id='evt-unique-1'
      AND status='received') THEN
    RAISE EXCEPTION 'webhook receipt was not persisted';
  END IF;
  BEGIN
    INSERT INTO payment_provider_webhook_events
      (id,provider_key,provider_event_id,payload_sha256,status)
    VALUES ('webhook-duplicate','test-provider','evt-unique-1',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','received');
    RAISE EXCEPTION 'duplicate provider event unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO payment_provider_webhook_events
      (id,provider_key,provider_event_id,payload_sha256,status)
    VALUES ('webhook-invalid','test-provider','evt-invalid','not-a-hash','received');
    RAISE EXCEPTION 'invalid webhook payload digest unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE payment_provider_webhook_events
    SET status='applied',processed_at=now()
    WHERE id='webhook-1';
  IF NOT EXISTS (SELECT 1 FROM payment_provider_webhook_events
    WHERE id='webhook-1' AND status='applied' AND processed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'webhook terminal state was not recorded';
  END IF;
END $$;
ROLLBACK;
