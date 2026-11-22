-- Ambiguous provider responses must be quarantined, never blindly retried.
ALTER TABLE payment_adjustment_submission_outbox
  DROP CONSTRAINT payment_adjustment_submission_outbox_status_check;
ALTER TABLE payment_adjustment_submission_outbox
  ADD CONSTRAINT payment_adjustment_submission_outbox_status_check
  CHECK (status IN ('queued','processing','submitted','failed','dead_letter','reconciliation_required'));

CREATE OR REPLACE FUNCTION enforce_payment_adjustment_submission_outbox()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  adjustment_status text;
  adjustment_provider_key text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status, provider_key INTO adjustment_status, adjustment_provider_key
      FROM customer_payment_adjustments
      WHERE tenant_id = NEW.tenant_id AND id = NEW.adjustment_id FOR KEY SHARE;
    IF NOT FOUND OR adjustment_status <> 'provider_pending'
       OR adjustment_provider_key IS DISTINCT FROM NEW.provider_key THEN
      RAISE EXCEPTION 'payment_adjustment_submission_requires_matching_provider_pending_adjustment'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'queued' OR NEW.attempt_count <> 0
       OR NEW.provider_reference IS NOT NULL OR NEW.completed_at IS NOT NULL
       OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'payment_adjustment_submission_must_start_queued'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.adjustment_id IS DISTINCT FROM OLD.adjustment_id
     OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment_adjustment_submission_identity_is_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.provider_reference IS NOT NULL
     AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
    RAISE EXCEPTION 'payment_adjustment_submission_provider_reference_is_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'payment_adjustment_submission_attempt_count_invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'processing' AND OLD.status IN ('queued','processing')
     AND NEW.attempt_count = OLD.attempt_count + 1
     AND NEW.provider_reference IS NULL AND NEW.completed_at IS NULL THEN
    RETURN NEW;
  ELSIF NEW.status = 'queued' AND OLD.status = 'processing'
     AND NEW.attempt_count = OLD.attempt_count
     AND NEW.provider_reference IS NULL AND NEW.completed_at IS NULL THEN
    RETURN NEW;
  ELSIF NEW.status = 'reconciliation_required' AND OLD.status = 'processing'
     AND NEW.attempt_count = OLD.attempt_count
     AND NEW.provider_reference IS NULL AND NEW.completed_at IS NULL
     AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL THEN
    RETURN NEW;
  ELSIF NEW.status IN ('submitted','failed','dead_letter') AND OLD.status = 'processing'
     AND NEW.attempt_count = OLD.attempt_count THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payment_adjustment_submission_state_transition_invalid' USING ERRCODE = '23514';
END
$function$;
