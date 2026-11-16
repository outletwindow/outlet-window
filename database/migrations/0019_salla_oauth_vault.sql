-- OAuth state is stored only as a SHA-256 digest and consumed once.
CREATE TABLE IF NOT EXISTS salla_oauth_states (
  state_sha256 char(64) PRIMARY KEY CHECK (state_sha256 ~ '^[a-f0-9]{64}$'),
  tenant_id text NOT NULL,
  integration_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS salla_oauth_states_expiry_idx ON salla_oauth_states (expires_at);

-- Tokens are encrypted by the application with AES-256-GCM before persistence.
CREATE TABLE IF NOT EXISTS salla_oauth_tokens (
  tenant_id text NOT NULL,
  integration_id text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, integration_id),
  CHECK (length(iv) BETWEEN 12 AND 32),
  CHECK (length(auth_tag) BETWEEN 16 AND 32),
  CHECK (length(ciphertext) > 0)
);
