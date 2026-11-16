-- Durable, idempotent handoff from customer consent to provider submission.
-- The outbox stores intent only; it does not move money.
ALTER TABLE customer_payment_adjustment_events
  DROP CONSTRAINT IF EXISTS customer_payment_adjustment_events_event_type_check;

ALTER TABLE customer_payment_adjustment_events
  ADD CONSTRAINT customer_payment_adjustment_events_event_type_check
  CHECK (event_type IN (
    'created','customer_consented','customer_declined','provider_submission_queued',
    'provider_submitted','provider_confirmed','provider_failed','expired','cancelled'
  ));

CREATE TABLE payment_adjustment_submission_outbox (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  adjustment_id text NOT NULL,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-zA-Z0-9._-]{1,100}$'),
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 200),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','submitted','failed','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  provider_reference text,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_.:-]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, adjustment_id)
    REFERENCES customer_payment_adjustments(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, adjustment_id),
  UNIQUE (tenant_id, provider_key, idempotency_key),
  CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status = 'submitted' AND provider_reference IS NOT NULL AND completed_at IS NOT NULL)
    OR (status <> 'submitted' AND completed_at IS NULL)
  ),
  CHECK (provider_reference IS NULL OR length(trim(provider_reference)) BETWEEN 1 AND 240)
);

CREATE INDEX payment_adjustment_submission_outbox_due_idx
  ON payment_adjustment_submission_outbox (available_at, created_at)
  WHERE status = 'queued';

CREATE INDEX payment_adjustment_submission_outbox_expired_lease_idx
  ON payment_adjustment_submission_outbox (lease_expires_at)
  WHERE status = 'processing';
