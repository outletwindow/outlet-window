-- Add independently attributed review and resolution to payout exception cases.
ALTER TABLE merchant_payout_exception_cases
  ADD COLUMN review_started_by text,
  ADD COLUMN review_started_at timestamptz;

ALTER TABLE merchant_payout_exception_cases
  ADD CONSTRAINT merchant_payout_exception_review_attribution_check
  CHECK (
    (review_status='open' AND review_started_by IS NULL AND review_started_at IS NULL)
    OR
    (review_status IN ('under_review','resolved') AND review_started_by IS NOT NULL AND review_started_at IS NOT NULL)
  ),
  ADD CONSTRAINT merchant_payout_exception_independent_resolution_check
  CHECK (resolved_by IS NULL OR resolved_by<>review_started_by);

CREATE OR REPLACE FUNCTION guard_merchant_payout_exception_case()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'merchant_payout_exception_case_is_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
    OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
    OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
    OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
    OR NEW.event_type IS DISTINCT FROM OLD.event_type
    OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'merchant_payout_exception_evidence_is_immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.review_status='resolved' THEN
    RAISE EXCEPTION 'merchant_payout_exception_resolution_is_terminal' USING ERRCODE='55000';
  END IF;

  IF OLD.review_status='open' AND NEW.review_status NOT IN ('open','under_review') THEN
    RAISE EXCEPTION 'merchant_payout_exception_transition_invalid' USING ERRCODE='55000';
  END IF;
  IF OLD.review_status='under_review' AND NEW.review_status NOT IN ('under_review','resolved') THEN
    RAISE EXCEPTION 'merchant_payout_exception_transition_invalid' USING ERRCODE='55000';
  END IF;

  IF OLD.review_status='open' AND NEW.review_status='under_review' THEN
    IF NEW.review_started_by IS NULL OR NEW.review_started_at IS NULL THEN
      RAISE EXCEPTION 'merchant_payout_exception_review_attribution_required' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.review_status='open' AND NEW.review_status='open' THEN
    IF NEW.review_started_by IS NOT NULL OR NEW.review_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'merchant_payout_exception_review_not_started' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.review_started_by IS DISTINCT FROM OLD.review_started_by
      OR NEW.review_started_at IS DISTINCT FROM OLD.review_started_at THEN
      RAISE EXCEPTION 'merchant_payout_exception_review_attribution_immutable' USING ERRCODE='55000';
    END IF;
  END IF;

  IF NEW.review_status='resolved' THEN
    IF NEW.resolution_code IS NULL OR NEW.resolved_by IS NULL OR NEW.resolved_at IS NULL
      OR NEW.resolved_by=NEW.review_started_by THEN
      RAISE EXCEPTION 'merchant_payout_exception_independent_resolution_required' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.resolution_code IS NOT NULL OR NEW.resolution_note IS NOT NULL
      OR NEW.resolved_by IS NOT NULL OR NEW.resolved_at IS NOT NULL THEN
      RAISE EXCEPTION 'merchant_payout_exception_resolution_not_final' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
