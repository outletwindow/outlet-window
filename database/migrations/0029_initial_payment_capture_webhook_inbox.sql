-- Durable inbox dedicated to trusted initial-order payment capture events.
-- Raw webhook bodies and signatures are deliberately never persisted.
CREATE TABLE initial_payment_capture_webhook_events (
  id text PRIMARY KEY,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-zA-Z0-9._-]{1,100}$'),
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^[a-zA-Z0-9._:-]{1,240}$'),
  payment_intent_id text NOT NULL REFERENCES provider_payment_intents(id) ON DELETE RESTRICT,
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  event_type text NOT NULL CHECK (event_type = 'payment.captured'),
  provider_payment_reference text NOT NULL CHECK (length(trim(provider_payment_reference)) BETWEEN 1 AND 240),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  captured_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','applied','ignored','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,100}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider_key, provider_event_id),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
         (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status IN ('applied','ignored','failed') AND processed_at IS NOT NULL AND lease_owner IS NULL) OR
         (status IN ('received','processing') AND processed_at IS NULL))
);
CREATE INDEX initial_payment_capture_webhook_claim_idx
  ON initial_payment_capture_webhook_events(status,next_attempt_at,lease_expires_at,received_at)
  WHERE status IN ('received','processing');

CREATE OR REPLACE FUNCTION protect_initial_payment_capture_webhook_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.provider_key <> OLD.provider_key OR
     NEW.provider_event_id <> OLD.provider_event_id OR
     NEW.payment_intent_id <> OLD.payment_intent_id OR
     NEW.payload_sha256 <> OLD.payload_sha256 OR NEW.event_type <> OLD.event_type OR
     NEW.provider_payment_reference <> OLD.provider_payment_reference OR
     NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency OR
     NEW.captured_at <> OLD.captured_at OR NEW.received_at <> OLD.received_at THEN
    RAISE EXCEPTION 'initial_payment_capture_webhook_identity_is_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER initial_payment_capture_webhook_identity_immutable
BEFORE UPDATE ON initial_payment_capture_webhook_events
FOR EACH ROW EXECUTE FUNCTION protect_initial_payment_capture_webhook_identity();
CREATE OR REPLACE FUNCTION reject_initial_payment_capture_webhook_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'initial_payment_capture_webhook_events_cannot_be_truncated' USING ERRCODE='55000';
END $$;
CREATE TRIGGER initial_payment_capture_webhook_no_truncate
BEFORE TRUNCATE ON initial_payment_capture_webhook_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_initial_payment_capture_webhook_truncate();
