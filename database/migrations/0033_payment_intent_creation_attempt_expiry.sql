-- Expire a provider intent only after an authoritative reconciliation proves it is no longer payable.
-- Keep the provider reference and immutable provider_payment_intents row for late webhook verification.
ALTER TABLE payment_intent_creation_attempts
  DROP CONSTRAINT payment_intent_creation_attempts_status_check,
  DROP CONSTRAINT payment_intent_creation_attempts_check;
ALTER TABLE payment_intent_creation_attempts
  ADD CONSTRAINT payment_intent_creation_attempts_status_check
    CHECK (status IN ('dispatching','outcome_unknown','created','rejected','expired')),
  ADD CONSTRAINT payment_intent_creation_attempts_state_fields_check
    CHECK (
      (status = 'created' AND provider_payment_reference IS NOT NULL AND expires_at IS NOT NULL
        AND failure_code IS NULL AND provider_reconciliation_reference IS NULL)
      OR (status = 'expired' AND provider_payment_reference IS NOT NULL AND expires_at IS NOT NULL
        AND failure_code = 'PROVIDER_INTENT_EXPIRED' AND provider_reconciliation_reference IS NOT NULL)
      OR (status = 'rejected' AND provider_payment_reference IS NULL AND expires_at IS NULL AND failure_code IS NOT NULL)
      OR (status IN ('dispatching','outcome_unknown') AND provider_payment_reference IS NULL
        AND expires_at IS NULL AND failure_code IS NULL AND provider_reconciliation_reference IS NULL)
    );
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
       OR (OLD.status='outcome_unknown' AND NEW.status IN ('created','rejected'))
       OR (OLD.status='created' AND NEW.status='expired')) THEN
    RAISE EXCEPTION 'payment_intent_attempt_transition_invalid' USING ERRCODE='23514';
  END IF;
  IF OLD.status='outcome_unknown' AND NEW.status='rejected' AND NEW.provider_reconciliation_reference IS NULL THEN
    RAISE EXCEPTION 'payment_intent_attempt_reconciliation_required' USING ERRCODE='23514';
  END IF;
  IF NEW.status='created' AND (NEW.provider_payment_reference IS NULL OR NEW.expires_at IS NULL
      OR NEW.expires_at <= clock_timestamp() OR NEW.expires_at > clock_timestamp() + interval '24 hours') THEN
    RAISE EXCEPTION 'payment_intent_attempt_created_fields_invalid' USING ERRCODE='23514';
  END IF;
  IF OLD.status='created' AND NEW.status='expired' AND
      (NEW.provider_payment_reference IS DISTINCT FROM OLD.provider_payment_reference
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.expires_at IS NULL
       OR NEW.expires_at > clock_timestamp()
       OR NEW.failure_code IS DISTINCT FROM 'PROVIDER_INTENT_EXPIRED'
       OR NEW.provider_reconciliation_reference IS NULL
       OR length(trim(NEW.provider_reconciliation_reference)) NOT BETWEEN 1 AND 240) THEN
    RAISE EXCEPTION 'payment_intent_attempt_expiry_reconciliation_invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.status='rejected' AND NEW.failure_code IS NULL THEN
    RAISE EXCEPTION 'payment_intent_attempt_failure_code_required' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
