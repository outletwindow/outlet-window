-- A payout cannot be marked confirmed by a direct outbox update.
-- The atomic reconciliation function must first persist the verified provider event.
CREATE OR REPLACE FUNCTION guard_merchant_payout_outbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'merchant_payout_outbox_is_immutable' USING ERRCODE='55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.payout_intent_id IS DISTINCT FROM OLD.payout_intent_id
    OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
    OR NEW.destination_id IS DISTINCT FROM OLD.destination_id
    OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'merchant_payout_outbox_identity_is_immutable' USING ERRCODE='55000';
  END IF;

  IF NOT (
    (OLD.status='queued' AND NEW.status IN ('processing','failed','reconciliation_required')) OR
    (OLD.status='processing' AND NEW.status IN ('queued','submitted','failed','reconciliation_required')) OR
    (OLD.status='submitted' AND NEW.status IN ('confirmed','reconciliation_required')) OR
    (OLD.status=NEW.status AND OLD.status IN ('queued','processing'))
  ) THEN
    RAISE EXCEPTION 'merchant_payout_outbox_transition_invalid' USING ERRCODE='55000';
  END IF;

  IF OLD.status='submitted' AND NEW.status='confirmed' AND NOT EXISTS (
    SELECT 1
    FROM merchant_payout_provider_events e
    WHERE e.tenant_id=NEW.tenant_id
      AND e.outbox_id=NEW.id
      AND e.provider_key=NEW.provider_key
      AND e.provider_reference=NEW.provider_reference
      AND e.amount_minor=NEW.amount_minor
      AND e.currency=NEW.currency
      AND e.event_type='payout_confirmed'
      AND e.signature_verified=true
  ) THEN
    RAISE EXCEPTION 'merchant_payout_confirmation_requires_verified_provider_event'
      USING ERRCODE='55000';
  END IF;

  IF NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count+1 THEN
    RAISE EXCEPTION 'merchant_payout_outbox_attempt_count_invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$$;

-- The confirmation event is inserted only by the SECURITY DEFINER reconciliation
-- function; prevent ordinary application roles from manufacturing verification rows.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE
ON merchant_payout_provider_events FROM PUBLIC;
