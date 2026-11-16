-- Bind every refund submission to the exact provider payment capture for its order.
ALTER TABLE payment_adjustment_submission_outbox
  ADD COLUMN original_payment_reference text;
ALTER TABLE payment_adjustment_submission_outbox
  ADD CONSTRAINT payment_adjustment_submission_original_reference_check
  CHECK (original_payment_reference IS NULL OR
    length(trim(original_payment_reference)) BETWEEN 1 AND 240);

-- Backfill is a one-time migration-only enrichment; the previous trigger correctly
-- rejects ordinary same-state updates, so suspend it only for this verified backfill.
ALTER TABLE payment_adjustment_submission_outbox
  DISABLE TRIGGER payment_adjustment_submission_outbox_guard;

-- Backfill references for previously queued/submitted refund jobs where the trusted
-- capture evidence exists. Missing evidence is quarantined below, never guessed.
UPDATE payment_adjustment_submission_outbox AS o
SET original_payment_reference = c.provider_payment_reference
FROM customer_payment_adjustments AS a
JOIN verified_order_payment_captures AS c
  ON c.tenant_id=a.tenant_id AND c.order_id=a.order_id AND c.provider_key=a.provider_key
WHERE a.tenant_id=o.tenant_id AND a.id=o.adjustment_id
  AND a.adjustment_direction='refund'
  AND o.original_payment_reference IS NULL
  AND c.amount_minor >= a.amount_minor AND c.currency=a.currency;

ALTER TABLE payment_adjustment_submission_outbox
  ENABLE TRIGGER payment_adjustment_submission_outbox_guard;

CREATE OR REPLACE FUNCTION enforce_payment_adjustment_submission_outbox()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  adjustment_status text;
  adjustment_provider_key text;
  v_adjustment_direction text;
  adjustment_amount bigint;
  adjustment_currency char(3);
  captured_reference text;
  captured_amount bigint;
  captured_currency char(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status, provider_key, adjustment_direction, amount_minor, currency
      INTO adjustment_status, adjustment_provider_key, v_adjustment_direction,
           adjustment_amount, adjustment_currency
      FROM customer_payment_adjustments
      WHERE tenant_id = NEW.tenant_id AND id = NEW.adjustment_id
      FOR KEY SHARE;
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
    IF v_adjustment_direction = 'refund' THEN
      SELECT provider_payment_reference, amount_minor, currency
        INTO captured_reference, captured_amount, captured_currency
        FROM verified_order_payment_captures
        WHERE tenant_id=NEW.tenant_id
          AND order_id=(SELECT order_id FROM customer_payment_adjustments
                        WHERE tenant_id=NEW.tenant_id AND id=NEW.adjustment_id)
          AND provider_key=NEW.provider_key
        FOR UPDATE;
      IF NOT FOUND OR captured_reference IS NULL
         OR captured_amount < adjustment_amount
         OR captured_currency <> adjustment_currency THEN
        RAISE EXCEPTION 'refund_submission_requires_matching_verified_original_payment'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.original_payment_reference IS NOT NULL
         AND NEW.original_payment_reference IS DISTINCT FROM captured_reference THEN
        RAISE EXCEPTION 'refund_submission_original_payment_reference_mismatch'
          USING ERRCODE = '23514';
      END IF;
      NEW.original_payment_reference := captured_reference;
    ELSIF NEW.original_payment_reference IS NOT NULL THEN
      RAISE EXCEPTION 'additional_charge_must_not_set_original_refund_reference'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.adjustment_id IS DISTINCT FROM OLD.adjustment_id
     OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.original_payment_reference IS DISTINCT FROM OLD.original_payment_reference
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment_adjustment_submission_identity_is_immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.provider_reference IS NOT NULL
     AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
    RAISE EXCEPTION 'payment_adjustment_submission_provider_reference_is_immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count
     OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'payment_adjustment_submission_attempt_count_invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'processing' AND OLD.status IN ('queued','processing')
     AND NEW.attempt_count = OLD.attempt_count + 1
     AND NEW.provider_reference IS NULL AND NEW.completed_at IS NULL THEN
    RETURN NEW;
  ELSIF NEW.status = 'queued' AND OLD.status = 'processing'
     AND NEW.attempt_count = OLD.attempt_count
     AND NEW.provider_reference IS NULL AND NEW.completed_at IS NULL THEN
    RETURN NEW;
  ELSIF NEW.status = 'reconciliation_required' AND OLD.status IN ('queued','processing','submitted')
     AND NEW.attempt_count = OLD.attempt_count
     AND NEW.completed_at IS NULL
     AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL THEN
    RETURN NEW;
  ELSIF NEW.status IN ('submitted','failed','dead_letter') AND OLD.status = 'processing'
     AND NEW.attempt_count = OLD.attempt_count THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payment_adjustment_submission_state_transition_invalid'
    USING ERRCODE = '23514';
END
$function$;

-- Legacy refund jobs without matching verified capture evidence cannot be safely sent
-- or reconciled automatically. Preserve any provider reference and quarantine them.
UPDATE payment_adjustment_submission_outbox AS o
SET status='reconciliation_required',completed_at=NULL,
    lease_owner=NULL,lease_expires_at=NULL,
    last_error_code='ORIGINAL_PAYMENT_CAPTURE_NOT_FOUND',updated_at=now()
FROM customer_payment_adjustments AS a
WHERE a.tenant_id=o.tenant_id AND a.id=o.adjustment_id
  AND a.adjustment_direction='refund'
  AND o.original_payment_reference IS NULL
  AND o.status IN ('queued','processing','submitted');
