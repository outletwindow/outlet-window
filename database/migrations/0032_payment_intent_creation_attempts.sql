-- Durable server-side ledger for provider intent creation attempts.
-- An ambiguous request is never automatically dispatched again.
CREATE TABLE payment_intent_creation_attempts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-zA-Z0-9._-]{1,100}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[a-zA-Z0-9._:-]{8,240}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 100),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('dispatching','outcome_unknown','created','rejected')),
  provider_payment_reference text,
  expires_at timestamptz,
  failure_code text,
  provider_reconciliation_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES customer_orders(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,idempotency_key),
  CHECK (
    (status = 'created' AND provider_payment_reference IS NOT NULL AND expires_at IS NOT NULL
      AND failure_code IS NULL AND provider_reconciliation_reference IS NULL)
    OR (status = 'rejected' AND provider_payment_reference IS NULL AND expires_at IS NULL
      AND failure_code IS NOT NULL)
    OR (status IN ('dispatching','outcome_unknown') AND provider_payment_reference IS NULL
      AND expires_at IS NULL AND failure_code IS NULL AND provider_reconciliation_reference IS NULL)
  ),
  CHECK (provider_payment_reference IS NULL OR length(trim(provider_payment_reference)) BETWEEN 1 AND 240),
  CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,80}$'),
  CHECK (provider_reconciliation_reference IS NULL OR length(trim(provider_reconciliation_reference)) BETWEEN 1 AND 240)
);
CREATE UNIQUE INDEX payment_intent_attempts_active_order_idx
  ON payment_intent_creation_attempts(tenant_id,order_id,provider_key)
  WHERE status IN ('dispatching','outcome_unknown','created');
CREATE UNIQUE INDEX payment_intent_attempts_provider_ref_idx
  ON payment_intent_creation_attempts(provider_key,provider_payment_reference)
  WHERE provider_payment_reference IS NOT NULL;
CREATE INDEX payment_intent_attempts_order_idx
  ON payment_intent_creation_attempts(tenant_id,order_id,created_at DESC);

CREATE OR REPLACE FUNCTION validate_payment_intent_creation_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_row customer_orders%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO order_row FROM customer_orders
      WHERE tenant_id=NEW.tenant_id AND id=NEW.order_id FOR UPDATE;
    IF NOT FOUND OR order_row.status <> 'awaiting_payment' THEN
      RAISE EXCEPTION 'payment_intent_attempt_order_not_payable' USING ERRCODE='23514';
    END IF;
    IF NEW.amount_minor <> order_row.total_minor OR NEW.currency <> order_row.currency THEN
      RAISE EXCEPTION 'payment_intent_attempt_amount_currency_mismatch' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.tenant_id,NEW.order_id,NEW.provider_key,NEW.idempotency_key,NEW.amount_minor,NEW.currency,NEW.created_at)
     IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.order_id,OLD.provider_key,OLD.idempotency_key,OLD.amount_minor,OLD.currency,OLD.created_at) THEN
    RAISE EXCEPTION 'payment_intent_attempt_identity_immutable' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.status='dispatching' AND NEW.status IN ('outcome_unknown','created','rejected'))
       OR (OLD.status='outcome_unknown' AND NEW.status IN ('created','rejected'))) THEN
    RAISE EXCEPTION 'payment_intent_attempt_transition_invalid' USING ERRCODE='23514';
  END IF;
  IF OLD.status='outcome_unknown' AND NEW.status='rejected' AND NEW.provider_reconciliation_reference IS NULL THEN
    RAISE EXCEPTION 'payment_intent_attempt_reconciliation_required' USING ERRCODE='23514';
  END IF;
  IF NEW.status='created' AND (NEW.provider_payment_reference IS NULL OR NEW.expires_at IS NULL
      OR NEW.expires_at <= clock_timestamp()
      OR NEW.expires_at > clock_timestamp() + interval '24 hours') THEN
    RAISE EXCEPTION 'payment_intent_attempt_created_fields_invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.status='rejected' AND NEW.failure_code IS NULL THEN
    RAISE EXCEPTION 'payment_intent_attempt_failure_code_required' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER payment_intent_attempts_validate
BEFORE INSERT OR UPDATE ON payment_intent_creation_attempts
FOR EACH ROW EXECUTE FUNCTION validate_payment_intent_creation_attempt();

CREATE OR REPLACE FUNCTION reject_payment_intent_attempt_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment_intent_creation_attempts_are_append_only' USING ERRCODE='55000';
END $$;
CREATE TRIGGER payment_intent_attempts_no_delete
BEFORE DELETE OR TRUNCATE ON payment_intent_creation_attempts
FOR EACH STATEMENT EXECUTE FUNCTION reject_payment_intent_attempt_delete();
