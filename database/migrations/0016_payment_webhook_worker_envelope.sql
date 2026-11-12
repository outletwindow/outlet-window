-- Canonical, minimal event envelope and lease metadata for recoverable payment webhook workers.
ALTER TABLE payment_provider_webhook_events
  ADD COLUMN event_type text,
  ADD COLUMN normalized_status text,
  ADD COLUMN provider_reference text,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz;

ALTER TABLE payment_provider_webhook_events
  ADD CONSTRAINT payment_provider_webhook_event_type_check
    CHECK (event_type IS NULL OR length(trim(event_type)) BETWEEN 1 AND 160),
  ADD CONSTRAINT payment_provider_webhook_normalized_status_check
    CHECK (normalized_status IS NULL OR normalized_status IN ('succeeded','failed','ignored','unsupported')),
  ADD CONSTRAINT payment_provider_webhook_provider_reference_check
    CHECK (provider_reference IS NULL OR length(trim(provider_reference)) BETWEEN 1 AND 240),
  ADD CONSTRAINT payment_provider_webhook_attempt_count_check
    CHECK (attempt_count BETWEEN 0 AND 20),
  ADD CONSTRAINT payment_provider_webhook_lease_pair_check
    CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
           (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL));

CREATE INDEX payment_provider_webhook_events_claim_idx
  ON payment_provider_webhook_events(status, next_attempt_at, lease_expires_at, received_at)
  WHERE status IN ('received','processing');
