-- Append-only audit events with tenant-scoped query indexes.
CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  event_type text NOT NULL CHECK (length(trim(event_type)) BETWEEN 1 AND 160),
  category text NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 100),
  occurred_at timestamptz NOT NULL,
  actor_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('customer','merchant_user','shopper','courier','platform_user','ai_agent','integration','system')),
  actor_role text,
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success','failure','denied','pending')),
  resource_type text,
  resource_id text,
  tenant_id text,
  merchant_id text,
  branch_id text,
  correlation_id text NOT NULL,
  request_id text,
  source text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warning','high','critical')),
  approval_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_tenant_time_idx ON audit_events (tenant_id, occurred_at DESC, id);
CREATE INDEX IF NOT EXISTS audit_events_merchant_time_idx ON audit_events (merchant_id, occurred_at DESC, id);
CREATE INDEX IF NOT EXISTS audit_events_correlation_idx ON audit_events (correlation_id);
CREATE OR REPLACE FUNCTION prevent_audit_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;
DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();
