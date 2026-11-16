-- Explicit customer consent and provider evidence for post-checkout price adjustments.
-- This migration records authorization workflow only; it does not charge or refund funds.
CREATE TABLE IF NOT EXISTS customer_payment_adjustments (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  customer_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 200),
  quote_reference text NOT NULL CHECK (length(trim(quote_reference)) BETWEEN 1 AND 240),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  adjustment_direction text NOT NULL CHECK (adjustment_direction IN ('additional_charge','refund')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  previous_total_minor bigint NOT NULL CHECK (previous_total_minor >= 0),
  proposed_total_minor bigint NOT NULL CHECK (proposed_total_minor >= 0),
  status text NOT NULL CHECK (status IN (
    'awaiting_customer_consent','consented','provider_pending','provider_confirmed',
    'provider_failed','declined','expired','cancelled'
  )),
  consented_at timestamptz,
  consent_actor_id text,
  provider_reference text,
  provider_confirmed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES customer_orders(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  CHECK (expires_at > created_at),
  CHECK (
    (adjustment_direction = 'additional_charge' AND proposed_total_minor > previous_total_minor
      AND amount_minor = proposed_total_minor - previous_total_minor)
    OR
    (adjustment_direction = 'refund' AND proposed_total_minor < previous_total_minor
      AND amount_minor = previous_total_minor - proposed_total_minor)
  ),
  CHECK (
    (status IN ('consented','provider_pending','provider_confirmed','provider_failed')
      AND consented_at IS NOT NULL AND consent_actor_id IS NOT NULL)
    OR status NOT IN ('consented','provider_pending','provider_confirmed','provider_failed')
  ),
  CHECK (
    (status = 'provider_confirmed' AND provider_reference IS NOT NULL AND provider_confirmed_at IS NOT NULL)
    OR status <> 'provider_confirmed'
  ),
  CHECK (provider_reference IS NULL OR length(trim(provider_reference)) BETWEEN 1 AND 240)
);
CREATE INDEX IF NOT EXISTS customer_payment_adjustments_order_idx
  ON customer_payment_adjustments (tenant_id, order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_payment_adjustments_pending_idx
  ON customer_payment_adjustments (status, expires_at)
  WHERE status IN ('awaiting_customer_consent','consented','provider_pending');

CREATE TABLE IF NOT EXISTS customer_payment_adjustment_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  adjustment_id text NOT NULL,
  actor_id text NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (event_type IN (
    'created','customer_consented','customer_declined','provider_submitted',
    'provider_confirmed','provider_failed','expired','cancelled'
  )),
  occurred_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  FOREIGN KEY (tenant_id, adjustment_id) REFERENCES customer_payment_adjustments(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS customer_payment_adjustment_events_history_idx
  ON customer_payment_adjustment_events (tenant_id, adjustment_id, occurred_at, id);

CREATE OR REPLACE FUNCTION prevent_customer_payment_adjustment_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'customer_payment_adjustment_events_are_append_only';
END;
$function$;
DROP TRIGGER IF EXISTS customer_payment_adjustment_events_no_update ON customer_payment_adjustment_events;
CREATE TRIGGER customer_payment_adjustment_events_no_update
BEFORE UPDATE OR DELETE ON customer_payment_adjustment_events
FOR EACH ROW EXECUTE FUNCTION prevent_customer_payment_adjustment_event_mutation();

