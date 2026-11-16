-- Trusted initial-order payment capture evidence.
-- Rows are written only by a provider-verification worker/service, never by customer routes.
CREATE TABLE IF NOT EXISTS verified_order_payment_captures (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-zA-Z0-9._-]{1,100}$'),
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^[a-zA-Z0-9._:-]{1,240}$'),
  provider_payment_reference text NOT NULL CHECK (length(trim(provider_payment_reference)) BETWEEN 1 AND 240),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  captured_at timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 240),
  verified_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES customer_orders(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (provider_key, provider_event_id),
  UNIQUE (provider_key, provider_payment_reference),
  UNIQUE (tenant_id, order_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS verified_order_payment_captures_order_idx
  ON verified_order_payment_captures (tenant_id, order_id, verified_at DESC);

CREATE OR REPLACE FUNCTION validate_verified_order_payment_capture()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  order_row customer_orders%ROWTYPE;
BEGIN
  SELECT * INTO order_row
  FROM customer_orders
  WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id
  FOR UPDATE;

  IF NOT FOUND OR order_row.status <> 'awaiting_payment' THEN
    RAISE EXCEPTION 'verified_payment_capture_order_not_payable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.amount_minor <> order_row.total_minor OR NEW.currency <> order_row.currency THEN
    RAISE EXCEPTION 'verified_payment_capture_amount_currency_mismatch'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.captured_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'verified_payment_capture_timestamp_in_future'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER verified_order_payment_captures_validate
BEFORE INSERT ON verified_order_payment_captures
FOR EACH ROW EXECUTE FUNCTION validate_verified_order_payment_capture();

CREATE OR REPLACE FUNCTION reject_verified_order_payment_capture_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'verified_order_payment_captures_are_immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER verified_order_payment_captures_no_update_delete
BEFORE UPDATE OR DELETE ON verified_order_payment_captures
FOR EACH ROW EXECUTE FUNCTION reject_verified_order_payment_capture_mutation();

CREATE TRIGGER verified_order_payment_captures_no_truncate
BEFORE TRUNCATE ON verified_order_payment_captures
FOR EACH STATEMENT EXECUTE FUNCTION reject_verified_order_payment_capture_mutation();
