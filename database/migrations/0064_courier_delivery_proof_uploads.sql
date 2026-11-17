-- Short-lived, tenant-scoped upload intents for courier proof-of-delivery.
-- Object bytes remain in private storage; this table stores only server-owned metadata.
CREATE TABLE courier_delivery_proof_uploads (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  courier_id text NOT NULL CHECK (length(trim(courier_id)) BETWEEN 1 AND 200),
  object_key text NOT NULL UNIQUE CHECK (length(trim(object_key)) BETWEEN 1 AND 500),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  expected_content_length bigint NOT NULL CHECK (expected_content_length BETWEEN 1 AND 10485760),
  expected_content_sha256 text NOT NULL CHECK (expected_content_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','expired','rejected')),
  expires_at timestamptz NOT NULL,
  verified_evidence_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, task_id)
    REFERENCES courier_delivery_tasks(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'verified') = (verified_evidence_id IS NOT NULL)),
  CHECK ((status = 'verified') = (completed_at IS NOT NULL))
);
CREATE INDEX courier_delivery_proof_uploads_task_idx
  ON courier_delivery_proof_uploads (tenant_id, task_id, created_at DESC);
CREATE INDEX courier_delivery_proof_uploads_expiry_idx
  ON courier_delivery_proof_uploads (expires_at)
  WHERE status = 'pending';
