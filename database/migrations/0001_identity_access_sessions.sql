-- Outlet Window IAM foundation. PostgreSQL 16+.
CREATE TABLE IF NOT EXISTS identities (
  id text PRIMARY KEY,
  principal_type text NOT NULL CHECK (principal_type IN ('human','service')),
  status text NOT NULL CHECK (status IN ('pending_verification','active','temporarily_restricted','suspended','recovery_pending','closed','deletion_requested')),
  display_name text,
  primary_email text,
  primary_phone text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT identities_contact_required CHECK (principal_type = 'service' OR primary_email IS NOT NULL OR primary_phone IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS identities_email_unique ON identities (lower(primary_email)) WHERE primary_email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS identities_phone_unique ON identities (primary_phone) WHERE primary_phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS role_assignments (
  id text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  role text NOT NULL,
  scope jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  assigned_by text NOT NULL,
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE INDEX IF NOT EXISTS role_assignments_principal_active_idx
  ON role_assignments (principal_id, active, valid_from, valid_until);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at timestamptz,
  device_label text,
  authentication_methods jsonb NOT NULL,
  token_digest text NOT NULL,
  family_id text NOT NULL,
  rotated_from_session_id text REFERENCES sessions(id) ON DELETE RESTRICT,
  token_issued_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (idle_expires_at > created_at),
  CHECK (last_seen_at >= created_at)
);
CREATE INDEX IF NOT EXISTS sessions_principal_idx ON sessions (principal_id);
CREATE INDEX IF NOT EXISTS sessions_family_idx ON sessions (family_id, principal_id);
CREATE INDEX IF NOT EXISTS sessions_active_expiry_idx ON sessions (expires_at, idle_expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
