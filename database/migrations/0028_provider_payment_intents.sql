-- Server-owned provider payment intent references.
-- Insert only after a trusted backend has created the intent with the PSP.
CREATE TABLE IF NOT EXISTS provider_payment_intents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-zA-Z0-9._-]{1,100}$'),
  provider_payment_reference text NOT NULL CHECK (length(trim(provider_payment_reference)) BETWEEN 1 AND 240),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 240),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES customer_orders(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (provider_key, provider_payment_reference),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, order_id, id)
);
CREATE INDEX IF NOT EXISTS provider_payment_intents_order_idx
  ON provider_payment_intents (tenant_id, order_id, created_at DESC);

CREATE OR REPLACE FUNCTION validate_provider_payment_intent()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_row customer_orders%ROWTYPE;
BEGIN
  SELECT * INTO order_row FROM customer_orders
   WHERE tenant_id=NEW.tenant_id AND id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR order_row.status <> 'awaiting_payment' THEN
    RAISE EXCEPTION 'payment_intent_order_not_payable' USING ERRCODE='23514';
  END IF;
  IF NEW.amount_minor <> order_row.total_minor OR NEW.currency <> order_row.currency THEN
    RAISE EXCEPTION 'payment_intent_amount_currency_mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.expires_at <= clock_timestamp() OR NEW.expires_at > clock_timestamp() + interval '24 hours' THEN
    RAISE EXCEPTION 'payment_intent_expiry_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_payment_intents_validate
BEFORE INSERT ON provider_payment_intents
FOR EACH ROW EXECUTE FUNCTION validate_provider_payment_intent();

CREATE OR REPLACE FUNCTION reject_provider_payment_intent_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider_payment_intents_are_immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER provider_payment_intents_no_update_delete
BEFORE UPDATE OR DELETE ON provider_payment_intents
FOR EACH ROW EXECUTE FUNCTION reject_provider_payment_intent_mutation();
CREATE TRIGGER provider_payment_intents_no_truncate
BEFORE TRUNCATE ON provider_payment_intents
FOR EACH STATEMENT EXECUTE FUNCTION reject_provider_payment_intent_mutation();
