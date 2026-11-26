-- Persist verified non-paid payout outcomes for controlled reconciliation.
-- This migration deliberately does not reverse posted journals automatically.
ALTER TABLE merchant_payout_provider_events
  DROP CONSTRAINT IF EXISTS merchant_payout_provider_events_event_type_check;
ALTER TABLE merchant_payout_provider_events
  ADD CONSTRAINT merchant_payout_provider_events_event_type_check
  CHECK (event_type IN (
    'payout_submitted','payout_confirmed','payout_failed',
    'payout_canceled','payout_returned'
  ));

CREATE TABLE merchant_payout_exception_cases (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  outbox_id text NOT NULL,
  provider_key text NOT NULL,
  provider_event_id text NOT NULL,
  provider_reference text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('payout_failed','payout_canceled','payout_returned')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  review_status text NOT NULL DEFAULT 'open'
    CHECK (review_status IN ('open','under_review','resolved')),
  resolution_code text CHECK (resolution_code IS NULL OR resolution_code ~ '^[A-Z0-9_.:-]{1,100}$'),
  resolution_note text CHECK (resolution_note IS NULL OR length(resolution_note) <= 2000),
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,outbox_id)
    REFERENCES merchant_payout_provider_outbox(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,provider_key,provider_event_id),
  CHECK (
    (review_status='resolved' AND resolution_code IS NOT NULL
      AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
    OR
    (review_status<>'resolved' AND resolution_code IS NULL
      AND resolved_by IS NULL AND resolved_at IS NULL)
  )
);
CREATE INDEX merchant_payout_exception_cases_open_idx
  ON merchant_payout_exception_cases(created_at,id)
  WHERE review_status<>'resolved';

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
  IF OLD.review_status='open' AND NEW.review_status NOT IN ('open','under_review','resolved') THEN
    RAISE EXCEPTION 'merchant_payout_exception_transition_invalid' USING ERRCODE='55000';
  END IF;
  IF OLD.review_status='under_review' AND NEW.review_status NOT IN ('under_review','resolved') THEN
    RAISE EXCEPTION 'merchant_payout_exception_transition_invalid' USING ERRCODE='55000';
  END IF;
  IF NEW.review_status='resolved' AND (
    NEW.resolution_code IS NULL OR NEW.resolved_by IS NULL OR NEW.resolved_at IS NULL
  ) THEN
    RAISE EXCEPTION 'merchant_payout_exception_resolution_attribution_required' USING ERRCODE='23514';
  END IF;
  IF OLD.review_status<>'resolved' AND NEW.review_status<>'resolved'
    AND (NEW.resolution_code IS NOT NULL OR NEW.resolution_note IS NOT NULL
      OR NEW.resolved_by IS NOT NULL OR NEW.resolved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'merchant_payout_exception_resolution_not_final' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER merchant_payout_exception_case_guard
BEFORE UPDATE OR DELETE ON merchant_payout_exception_cases
FOR EACH ROW EXECUTE FUNCTION guard_merchant_payout_exception_case();

CREATE OR REPLACE FUNCTION record_verified_merchant_payout_exception(
  p_case_id text,
  p_event_row_id text,
  p_tenant_id text,
  p_outbox_id text,
  p_provider_key text,
  p_provider_event_id text,
  p_provider_reference text,
  p_event_type text,
  p_amount_minor bigint,
  p_currency text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  payout_row merchant_payout_provider_outbox%ROWTYPE;
  existing_event merchant_payout_provider_events%ROWTYPE;
  case_id_value text;
BEGIN
  IF p_case_id IS NULL OR length(trim(p_case_id))=0
    OR p_event_row_id IS NULL OR length(trim(p_event_row_id))=0
    OR p_tenant_id IS NULL OR length(trim(p_tenant_id))=0
    OR p_outbox_id IS NULL OR length(trim(p_outbox_id))=0
    OR p_provider_key IS NULL OR length(trim(p_provider_key))=0
    OR p_provider_event_id IS NULL OR length(trim(p_provider_event_id)) NOT BETWEEN 1 AND 240
    OR p_provider_reference IS NULL OR length(trim(p_provider_reference)) NOT BETWEEN 1 AND 240
    OR p_event_type NOT IN ('payout_failed','payout_canceled','payout_returned')
    OR p_amount_minor IS NULL OR p_amount_minor<=0
    OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'merchant_payout_exception_input_invalid' USING ERRCODE='22023';
  END IF;

  SELECT * INTO payout_row
  FROM merchant_payout_provider_outbox
  WHERE tenant_id=p_tenant_id AND id=p_outbox_id
  FOR UPDATE;
  IF NOT FOUND OR payout_row.provider_key<>p_provider_key
    OR payout_row.provider_reference<>p_provider_reference
    OR payout_row.amount_minor<>p_amount_minor
    OR payout_row.currency<>p_currency THEN
    RAISE EXCEPTION 'merchant_payout_exception_outbox_mismatch' USING ERRCODE='23514';
  END IF;

  IF (p_event_type IN ('payout_failed','payout_canceled') AND payout_row.status<>'submitted')
    OR (p_event_type='payout_returned' AND payout_row.status<>'confirmed') THEN
    RAISE EXCEPTION 'merchant_payout_exception_status_mismatch' USING ERRCODE='23514';
  END IF;

  SELECT * INTO existing_event
  FROM merchant_payout_provider_events
  WHERE tenant_id=p_tenant_id AND provider_key=p_provider_key
    AND provider_event_id=p_provider_event_id;
  IF FOUND THEN
    IF existing_event.outbox_id<>p_outbox_id
      OR existing_event.provider_reference<>p_provider_reference
      OR existing_event.amount_minor<>p_amount_minor
      OR existing_event.currency<>p_currency
      OR existing_event.event_type<>p_event_type
      OR existing_event.signature_verified IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'merchant_payout_exception_event_collision' USING ERRCODE='23505';
    END IF;
    SELECT id INTO case_id_value
    FROM merchant_payout_exception_cases
    WHERE tenant_id=p_tenant_id AND provider_key=p_provider_key
      AND provider_event_id=p_provider_event_id;
    IF case_id_value IS NULL THEN
      RAISE EXCEPTION 'merchant_payout_exception_case_missing' USING ERRCODE='23514';
    END IF;
    RETURN case_id_value;
  END IF;

  INSERT INTO merchant_payout_provider_events
    (id,tenant_id,outbox_id,provider_key,provider_event_id,provider_reference,
     event_type,signature_verified,amount_minor,currency)
  VALUES
    (p_event_row_id,p_tenant_id,p_outbox_id,p_provider_key,p_provider_event_id,
     p_provider_reference,p_event_type,true,p_amount_minor,p_currency);

  INSERT INTO merchant_payout_exception_cases
    (id,tenant_id,outbox_id,provider_key,provider_event_id,provider_reference,
     event_type,amount_minor,currency)
  VALUES
    (p_case_id,p_tenant_id,p_outbox_id,p_provider_key,p_provider_event_id,
     p_provider_reference,p_event_type,p_amount_minor,p_currency)
  RETURNING id INTO case_id_value;

  RETURN case_id_value;
END
$$;
REVOKE ALL ON FUNCTION record_verified_merchant_payout_exception(text,text,text,text,text,text,text,text,bigint,text) FROM PUBLIC;
