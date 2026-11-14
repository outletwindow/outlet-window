-- Durable deduplication ledger for signed payment provider webhooks.
CREATE TABLE IF NOT EXISTS payment_provider_webhook_events (
  id text PRIMARY KEY,
  provider_key text NOT NULL CHECK (length(trim(provider_key)) BETWEEN 1 AND 100),
  provider_event_id text NOT NULL CHECK (length(trim(provider_event_id)) BETWEEN 1 AND 240),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('received','processing','applied','ignored','failed')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  adjustment_id text,
  failure_code text,
  UNIQUE (provider_key, provider_event_id),
  FOREIGN KEY (adjustment_id) REFERENCES customer_payment_adjustments(id) ON DELETE RESTRICT,
  CHECK ((status IN ('applied','ignored','failed') AND processed_at IS NOT NULL) OR
         (status IN ('received','processing') AND processed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS payment_provider_webhook_events_pending_idx
  ON payment_provider_webhook_events(status, received_at)
  WHERE status IN ('received','processing');
