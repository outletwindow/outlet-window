-- Durable, provider-scoped evidence for physical fulfillment handovers.
-- Signature verification happens in the API before an event reaches this table.
CREATE TABLE fulfillment_handover_events (
  id text PRIMARY KEY,
  provider_key text NOT NULL CHECK (provider_key ~ '^[A-Za-z0-9._-]{1,100}$'),
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^[A-Za-z0-9._:-]{1,240}$'),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  tenant_id text NOT NULL,
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  reservation_id text NOT NULL,
  handover_reference text NOT NULL CHECK (length(handover_reference) BETWEEN 1 AND 240),
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','applied','rejected')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  failure_code text,
  UNIQUE (provider_key, provider_event_id),
  CHECK ((status = 'received' AND processed_at IS NULL) OR
         (status IN ('applied','rejected') AND processed_at IS NOT NULL))
);
CREATE INDEX fulfillment_handover_events_pending_idx
  ON fulfillment_handover_events (received_at, id) WHERE status = 'received';
CREATE INDEX fulfillment_handover_events_reservation_idx
  ON fulfillment_handover_events (tenant_id, merchant_id, branch_id, reservation_id, received_at);
