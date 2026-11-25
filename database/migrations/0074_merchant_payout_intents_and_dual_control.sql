-- Merchant payout intent and independent approval ledger.
-- This records permission to initiate a future disbursement; it never calls a PSP or bank.
CREATE TABLE merchant_payout_intents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  merchant_id text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  settlement_batch_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9000000000000000),
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 240),
  status text NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval','authorized','rejected')),
  requested_by text NOT NULL,
  requester_role text NOT NULL CHECK (requester_role IN ('operations','finance','platform_admin','platform_owner')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text,
  reviewer_role text CHECK (reviewer_role IS NULL OR reviewer_role IN ('finance','platform_admin','platform_owner')),
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR length(review_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,settlement_batch_id,merchant_id,currency)
    REFERENCES merchant_settlement_batches (tenant_id,id,merchant_id,currency) ON DELETE RESTRICT,
  UNIQUE (tenant_id,id),
    UNIQUE (tenant_id,idempotency_key),
  CHECK (
    (status='pending_approval' AND reviewed_by IS NULL AND reviewer_role IS NULL AND reviewed_at IS NULL)
    OR
    (status IN ('authorized','rejected') AND reviewed_by IS NOT NULL
      AND reviewer_role IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX merchant_payout_one_active_intent_per_batch_idx
  ON merchant_payout_intents (tenant_id,settlement_batch_id)
  WHERE status IN ('pending_approval','authorized');
CREATE INDEX merchant_payout_intents_review_queue_idx
  ON merchant_payout_intents (status,requested_at,id);

CREATE TABLE merchant_payout_decisions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  payout_intent_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('authorize','reject')),
  actor_id text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('finance','platform_admin','platform_owner')),
  reason text CHECK (reason IS NULL OR length(reason) <= 1000),
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,payout_intent_id)
    REFERENCES merchant_payout_intents (tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,payout_intent_id)
);

CREATE OR REPLACE FUNCTION initialize_merchant_payout_intent()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch_row merchant_settlement_batches%ROWTYPE;
  expected_net numeric;
BEGIN
  IF NEW.status <> 'pending_approval' OR NEW.reviewed_by IS NOT NULL
     OR NEW.reviewer_role IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
    RAISE EXCEPTION 'merchant_payout_intent_requires_independent_approval'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO batch_row
  FROM merchant_settlement_batches
  WHERE tenant_id=NEW.tenant_id AND id=NEW.settlement_batch_id
    AND merchant_id=NEW.merchant_id AND currency=NEW.currency
  FOR UPDATE;
  IF NOT FOUND OR batch_row.status <> 'approved' OR batch_row.journal_id IS NULL THEN
    RAISE EXCEPTION 'merchant_payout_requires_approved_settlement_batch'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM financial_journals
    WHERE tenant_id=NEW.tenant_id AND id=batch_row.journal_id
      AND currency=NEW.currency AND status='posted'
      AND source_type='merchant_settlement'
      AND source_reference=NEW.settlement_batch_id
  ) THEN
    RAISE EXCEPTION 'merchant_payout_requires_posted_settlement_journal'
      USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(net_minor),0) INTO expected_net
  FROM merchant_settlement_lines
  WHERE tenant_id=NEW.tenant_id AND batch_id=NEW.settlement_batch_id;
  IF expected_net <= 0 OR expected_net <> NEW.amount_minor THEN
    RAISE EXCEPTION 'merchant_payout_amount_must_match_settlement_net'
      USING ERRCODE='23514';
  END IF;
  INSERT INTO audit_events (
    id,schema_version,event_type,category,occurred_at,actor_id,actor_type,actor_role,
    action,outcome,resource_type,resource_id,tenant_id,merchant_id,
    correlation_id,source,severity,metadata
  ) VALUES (
    'merchant-payout-request:' || NEW.tenant_id || ':' || NEW.id,
    1,'merchant_payout_authorization_requested','finance',NEW.requested_at,
    NEW.requested_by,'platform_user',NEW.requester_role,'request_merchant_payout_authorization',
    'pending','merchant_payout_intent',NEW.id,NEW.tenant_id,NEW.merchant_id,
    NEW.id,'merchant_payout_authorization','high',
    jsonb_build_object('settlementBatchId',NEW.settlement_batch_id,
      'amountMinor',NEW.amount_minor,'currency',NEW.currency)
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER merchant_payout_intent_initialize
BEFORE INSERT ON merchant_payout_intents
FOR EACH ROW EXECUTE FUNCTION initialize_merchant_payout_intent();

CREATE OR REPLACE FUNCTION apply_merchant_payout_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payout_row merchant_payout_intents%ROWTYPE;
  next_status text;
BEGIN
  SELECT * INTO payout_row
  FROM merchant_payout_intents
  WHERE tenant_id=NEW.tenant_id AND id=NEW.payout_intent_id
  FOR UPDATE;
  IF NOT FOUND OR payout_row.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'merchant_payout_intent_not_pending'
      USING ERRCODE='23514';
  END IF;
  IF NEW.actor_id=payout_row.requested_by THEN
    RAISE EXCEPTION 'merchant_payout_requester_cannot_approve_own_request'
      USING ERRCODE='42501';
  END IF;
  next_status := CASE NEW.decision WHEN 'authorize' THEN 'authorized' ELSE 'rejected' END;
  UPDATE merchant_payout_intents
  SET status=next_status,reviewed_by=NEW.actor_id,reviewer_role=NEW.actor_role,
      reviewed_at=NEW.decided_at,review_note=NEW.reason
  WHERE tenant_id=NEW.tenant_id AND id=NEW.payout_intent_id;
  INSERT INTO audit_events (
    id,schema_version,event_type,category,occurred_at,actor_id,actor_type,actor_role,
    action,outcome,resource_type,resource_id,tenant_id,merchant_id,
    correlation_id,source,severity,approval_id,metadata
  ) VALUES (
    'merchant-payout-decision:' || NEW.tenant_id || ':' || NEW.id,
    1,CASE NEW.decision WHEN 'authorize' THEN 'merchant_payout_authorized' ELSE 'merchant_payout_rejected' END,
    'finance',NEW.decided_at,NEW.actor_id,'platform_user',NEW.actor_role,
    NEW.decision,CASE NEW.decision WHEN 'authorize' THEN 'success' ELSE 'denied' END,
    'merchant_payout_intent',NEW.payout_intent_id,NEW.tenant_id,payout_row.merchant_id,
    NEW.payout_intent_id,'merchant_payout_authorization','high',
    payout_row.id,jsonb_build_object('amountMinor',payout_row.amount_minor,
      'currency',payout_row.currency,'settlementBatchId',payout_row.settlement_batch_id,
      'decisionId',NEW.id,'reason',NEW.reason)
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER merchant_payout_decision_apply
BEFORE INSERT ON merchant_payout_decisions
FOR EACH ROW EXECUTE FUNCTION apply_merchant_payout_decision();

CREATE OR REPLACE FUNCTION guard_merchant_payout_intent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'merchant_payout_intents_are_immutable'
      USING ERRCODE='55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.settlement_batch_id IS DISTINCT FROM OLD.settlement_batch_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requester_role IS DISTINCT FROM OLD.requester_role
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'merchant_payout_intent_identity_is_immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.status <> 'pending_approval' OR NEW.status NOT IN ('authorized','rejected')
     OR NEW.reviewed_by IS NULL OR NEW.reviewer_role IS NULL OR NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'merchant_payout_intent_transition_invalid'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER merchant_payout_intent_guard
BEFORE UPDATE OR DELETE ON merchant_payout_intents
FOR EACH ROW EXECUTE FUNCTION guard_merchant_payout_intent();

CREATE OR REPLACE FUNCTION prevent_merchant_payout_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'merchant_payout_history_is_append_only' USING ERRCODE='55000';
END
$$;
CREATE TRIGGER merchant_payout_decisions_immutable
BEFORE UPDATE OR DELETE ON merchant_payout_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_merchant_payout_history_mutation();

CREATE OR REPLACE FUNCTION prevent_merchant_payout_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'merchant_payout_tables_cannot_be_truncated' USING ERRCODE='55000';
END
$$;
CREATE TRIGGER merchant_payout_intents_no_truncate
BEFORE TRUNCATE ON merchant_payout_intents
FOR EACH STATEMENT EXECUTE FUNCTION prevent_merchant_payout_truncate();
CREATE TRIGGER merchant_payout_decisions_no_truncate
BEFORE TRUNCATE ON merchant_payout_decisions
FOR EACH STATEMENT EXECUTE FUNCTION prevent_merchant_payout_truncate();
