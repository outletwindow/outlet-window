\set ON_ERROR_STOP on
BEGIN;

INSERT INTO fulfillment_handover_events
  (id,provider_key,provider_event_id,payload_sha256,tenant_id,merchant_id,
   branch_id,reservation_id,handover_reference,occurred_at)
VALUES
  ('ci-handover-event-1','carrier-a','event-100',repeat('a',64),
   'tenant-a','merchant-a','branch-a','reservation-a','carrier-a:handover-1',now());

-- A repeated provider event ID cannot create a second receipt.
DO $$
BEGIN
  BEGIN
    INSERT INTO fulfillment_handover_events
      (id,provider_key,provider_event_id,payload_sha256,tenant_id,merchant_id,
       branch_id,reservation_id,handover_reference,occurred_at)
    VALUES
      ('ci-handover-event-2','carrier-a','event-100',repeat('a',64),
       'tenant-a','merchant-a','branch-a','reservation-a','carrier-a:handover-1',now());
    RAISE EXCEPTION 'duplicate provider event unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF (SELECT count(*) FROM fulfillment_handover_events
      WHERE provider_key='carrier-a' AND provider_event_id='event-100') <> 1 THEN
    RAISE EXCEPTION 'provider event deduplication failed';
  END IF;
END $$;

-- A different payload under the same key is detectable by comparing the digest.
DO $$
DECLARE stored_digest text;
BEGIN
  SELECT payload_sha256 INTO stored_digest FROM fulfillment_handover_events
    WHERE provider_key='carrier-a' AND provider_event_id='event-100';
  IF stored_digest = repeat('b',64) THEN
    RAISE EXCEPTION 'payload collision was not distinguishable';
  END IF;
END $$;

ROLLBACK;
