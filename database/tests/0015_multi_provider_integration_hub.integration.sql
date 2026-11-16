\set ON_ERROR_STOP on
BEGIN;
INSERT INTO tenant_integrations
  (id,tenant_id,family,provider_key,display_name,status,secret_reference,capabilities,created_at,updated_at)
VALUES
  ('pos-1','tenant-a','pos','generic-pos','Branch POS','connected',
   'vault://tenant-a/pos-1','["catalog.read","inventory.read"]'::jsonb,now(),now());
INSERT INTO integration_event_inbox
  (id,tenant_id,integration_id,provider_event_id,event_type,idempotency_key,occurred_at,
   status,payload,payload_sha256)
VALUES
  ('event-1','tenant-a','pos-1','provider-event-1','inventory.updated','idem-1',now(),
   'received','{"sku":"SKU-1","quantity":3}'::jsonb,
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_integrations
    WHERE tenant_id='tenant-a' AND family='pos' AND status='connected') THEN
    RAISE EXCEPTION 'tenant integration was not registered';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM integration_event_inbox
    WHERE tenant_id='tenant-a' AND provider_event_id='provider-event-1' AND status='received') THEN
    RAISE EXCEPTION 'integration event was not accepted';
  END IF;
  BEGIN
    INSERT INTO integration_event_inbox
      (id,tenant_id,integration_id,provider_event_id,event_type,idempotency_key,occurred_at,
       status,payload,payload_sha256)
    VALUES
      ('event-duplicate','tenant-a','pos-1','provider-event-1','inventory.updated','idem-duplicate',now(),
       'received','{"sku":"SKU-1","quantity":4}'::jsonb,
       'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    RAISE EXCEPTION 'duplicate provider event unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO integration_event_inbox
      (id,tenant_id,integration_id,provider_event_id,event_type,idempotency_key,occurred_at,
       status,payload,payload_sha256)
    VALUES
      ('event-cross-tenant','tenant-b','pos-1','provider-event-2','inventory.updated','idem-2',now(),
       'received','{"sku":"SKU-1","quantity":4}'::jsonb,
       'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
    RAISE EXCEPTION 'cross-tenant integration event unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
ROLLBACK;
