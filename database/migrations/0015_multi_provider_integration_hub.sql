-- Tenant-scoped registry and durable idempotent event inbox for all integration families.
-- Credentials are represented only by secret-manager references; raw secrets are never stored here.
CREATE TABLE IF NOT EXISTS tenant_integrations (
  id text NOT NULL,
  tenant_id text NOT NULL,
  family text NOT NULL CHECK (family IN ('payments','commerce','pos','erp','carriers','maps')),
  provider_key text NOT NULL CHECK (length(trim(provider_key)) BETWEEN 1 AND 100),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 160),
  status text NOT NULL CHECK (status IN ('pending','connected','degraded','suspended','disconnected')),
  secret_reference text,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities) = 'array'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK (updated_at >= created_at),
  CHECK (secret_reference IS NULL OR length(trim(secret_reference)) BETWEEN 1 AND 500)
);
CREATE INDEX IF NOT EXISTS tenant_integrations_family_status_idx
  ON tenant_integrations (tenant_id, family, status, provider_key);

CREATE TABLE IF NOT EXISTS integration_event_inbox (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  integration_id text NOT NULL,
  provider_event_id text NOT NULL CHECK (length(trim(provider_event_id)) BETWEEN 1 AND 240),
  event_type text NOT NULL CHECK (length(trim(event_type)) BETWEEN 1 AND 160),
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 240),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('received','processing','processed','ignored','failed')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) IN ('object','array')),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  processed_at timestamptz,
  failure_code text,
  FOREIGN KEY (tenant_id, integration_id)
    REFERENCES tenant_integrations (tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, integration_id, provider_event_id),
  UNIQUE (tenant_id, integration_id, idempotency_key),
  CHECK ((status IN ('processed','ignored','failed') AND processed_at IS NOT NULL) OR
         (status IN ('received','processing') AND processed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS integration_event_inbox_pending_idx
  ON integration_event_inbox (status, received_at)
  WHERE status IN ('received','processing');
CREATE INDEX IF NOT EXISTS integration_event_inbox_tenant_history_idx
  ON integration_event_inbox (tenant_id, integration_id, received_at DESC);
