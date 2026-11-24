-- Two-person merchant settlement review controls.
-- This records authorization to proceed with accounting review only. It does not
-- post a journal, approve the settlement batch, or initiate a payout.

CREATE TABLE merchant_settlement_approval_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  batch_id text NOT NULL,
  merchant_id text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  requested_by text NOT NULL,
  requester_role text NOT NULL CHECK (requester_role IN
    ('operations','finance','platform_admin','platform_owner')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','authorized_for_accounting','rejected')),
  snapshot_line_count bigint NOT NULL DEFAULT 0 CHECK (snapshot_line_count >= 0),
  snapshot_gross_minor bigint NOT NULL DEFAULT 0 CHECK (snapshot_gross_minor >= 0),
  snapshot_deductions_minor bigint NOT NULL DEFAULT 0 CHECK (snapshot_deductions_minor >= 0),
  snapshot_net_minor bigint NOT NULL DEFAULT 0 CHECK (snapshot_net_minor >= 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text,
  reviewer_role text,
  reviewed_at timestamptz,
  review_note text,
  FOREIGN KEY (tenant_id,batch_id,merchant_id,currency)
    REFERENCES merchant_settlement_batches(tenant_id,id,merchant_id,currency) ON DELETE RESTRICT,
  UNIQUE (tenant_id,id),
  CHECK (snapshot_gross_minor = snapshot_deductions_minor + snapshot_net_minor),
  CHECK (
    (status='pending' AND reviewed_by IS NULL AND reviewer_role IS NULL AND reviewed_at IS NULL)
    OR
    (status IN ('authorized_for_accounting','rejected')
      AND reviewed_by IS NOT NULL AND reviewer_role IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CHECK (review_note IS NULL OR length(review_note) <= 1000)
);
CREATE UNIQUE INDEX merchant_settlement_one_open_approval_per_batch_idx
  ON merchant_settlement_approval_requests(tenant_id,batch_id)
  WHERE status IN ('pending','authorized_for_accounting');
CREATE INDEX merchant_settlement_approval_review_queue_idx
  ON merchant_settlement_approval_requests(status,requested_at,id);

CREATE TABLE merchant_settlement_approval_decisions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  request_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('authorize_accounting','reject')),
  actor_id text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN
    ('finance','platform_admin','platform_owner')),
  reason text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,request_id)
    REFERENCES merchant_settlement_approval_requests(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,request_id),
  CHECK (reason IS NULL OR length(reason) <= 1000)
);

CREATE OR REPLACE FUNCTION initialize_merchant_settlement_approval_request()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  batch_status text;
BEGIN
  SELECT status INTO batch_status
  FROM merchant_settlement_batches
  WHERE tenant_id=NEW.tenant_id AND id=NEW.batch_id
    AND merchant_id=NEW.merchant_id AND currency=NEW.currency
  FOR UPDATE;
  IF NOT FOUND OR batch_status <> 'draft' THEN
    RAISE EXCEPTION 'settlement_approval_requires_draft_batch'
      USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*),COALESCE(SUM(gross_minor),0),
         COALESCE(SUM(deductions_minor),0),COALESCE(SUM(net_minor),0)
    INTO NEW.snapshot_line_count,NEW.snapshot_gross_minor,
         NEW.snapshot_deductions_minor,NEW.snapshot_net_minor
  FROM merchant_settlement_lines
  WHERE tenant_id=NEW.tenant_id AND batch_id=NEW.batch_id;

  IF NEW.snapshot_line_count=0
     OR NEW.snapshot_gross_minor <> NEW.snapshot_deductions_minor + NEW.snapshot_net_minor THEN
    RAISE EXCEPTION 'settlement_approval_requires_nonempty_balanced_snapshot'
      USING ERRCODE='23514';
  END IF;

  INSERT INTO audit_events (
    id,schema_version,event_type,category,occurred_at,actor_id,actor_type,actor_role,
    action,outcome,resource_type,resource_id,tenant_id,merchant_id,
    correlation_id,source,severity,metadata
  ) VALUES (
    'settlement-approval-request:' || NEW.id,1,'merchant_settlement_approval_requested',
    'finance',NEW.requested_at,NEW.requested_by,'platform_user',NEW.requester_role,
    'request_accounting_authorization','pending','merchant_settlement_batch',NEW.batch_id,
    NEW.tenant_id,NEW.merchant_id,NEW.id,'merchant_settlement_approval','high',
    jsonb_build_object('approvalRequestId',NEW.id,'currency',NEW.currency,
      'lineCount',NEW.snapshot_line_count,'grossMinor',NEW.snapshot_gross_minor,
      'deductionsMinor',NEW.snapshot_deductions_minor,'netMinor',NEW.snapshot_net_minor)
  );
  RETURN NEW;
END
$function$;
CREATE TRIGGER merchant_settlement_approval_request_initialize
BEFORE INSERT ON merchant_settlement_approval_requests
FOR EACH ROW EXECUTE FUNCTION initialize_merchant_settlement_approval_request();

CREATE OR REPLACE FUNCTION guard_merchant_settlement_approval_request()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'settlement_approval_requests_are_immutable'
      USING ERRCODE='55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requester_role IS DISTINCT FROM OLD.requester_role
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.snapshot_line_count IS DISTINCT FROM OLD.snapshot_line_count
     OR NEW.snapshot_gross_minor IS DISTINCT FROM OLD.snapshot_gross_minor
     OR NEW.snapshot_deductions_minor IS DISTINCT FROM OLD.snapshot_deductions_minor
     OR NEW.snapshot_net_minor IS DISTINCT FROM OLD.snapshot_net_minor THEN
    RAISE EXCEPTION 'settlement_approval_request_identity_is_immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('authorized_for_accounting','rejected')
     OR NEW.reviewed_by IS NULL OR NEW.reviewer_role IS NULL OR NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'settlement_approval_request_transition_invalid'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER merchant_settlement_approval_request_guard
BEFORE UPDATE OR DELETE ON merchant_settlement_approval_requests
FOR EACH ROW EXECUTE FUNCTION guard_merchant_settlement_approval_request();

CREATE OR REPLACE FUNCTION apply_merchant_settlement_approval_decision()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  approval_row merchant_settlement_approval_requests%ROWTYPE;
  current_line_count bigint;
  current_gross numeric;
  current_deductions numeric;
  current_net numeric;
  next_status text;
BEGIN
  SELECT * INTO approval_row
  FROM merchant_settlement_approval_requests
  WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id
  FOR UPDATE;
  IF NOT FOUND OR approval_row.status <> 'pending' THEN
    RAISE EXCEPTION 'settlement_approval_request_not_pending'
      USING ERRCODE='23514';
  END IF;
  IF NEW.actor_id = approval_row.requested_by THEN
    RAISE EXCEPTION 'settlement_requester_cannot_approve_own_request'
      USING ERRCODE='42501';
  END IF;

  SELECT COUNT(*),COALESCE(SUM(gross_minor),0),
         COALESCE(SUM(deductions_minor),0),COALESCE(SUM(net_minor),0)
    INTO current_line_count,current_gross,current_deductions,current_net
  FROM merchant_settlement_lines
  WHERE tenant_id=approval_row.tenant_id AND batch_id=approval_row.batch_id;

  IF current_line_count <> approval_row.snapshot_line_count
     OR current_gross <> approval_row.snapshot_gross_minor
     OR current_deductions <> approval_row.snapshot_deductions_minor
     OR current_net <> approval_row.snapshot_net_minor THEN
    RAISE EXCEPTION 'settlement_approval_snapshot_changed'
      USING ERRCODE='23514';
  END IF;

  next_status := CASE NEW.decision
    WHEN 'authorize_accounting' THEN 'authorized_for_accounting'
    ELSE 'rejected'
  END;

  UPDATE merchant_settlement_approval_requests
  SET status=next_status,reviewed_by=NEW.actor_id,reviewer_role=NEW.actor_role,
      reviewed_at=NEW.decided_at,review_note=NEW.reason
  WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id;

  INSERT INTO audit_events (
    id,schema_version,event_type,category,occurred_at,actor_id,actor_type,actor_role,
    action,outcome,resource_type,resource_id,tenant_id,merchant_id,
    correlation_id,source,severity,approval_id,metadata
  ) VALUES (
    'settlement-approval-decision:' || NEW.id,1,
    CASE NEW.decision WHEN 'authorize_accounting'
      THEN 'merchant_settlement_accounting_authorized'
      ELSE 'merchant_settlement_approval_rejected' END,
    'finance',NEW.decided_at,NEW.actor_id,'platform_user',NEW.actor_role,
    NEW.decision,CASE NEW.decision WHEN 'authorize_accounting' THEN 'success' ELSE 'denied' END,
    'merchant_settlement_batch',approval_row.batch_id,approval_row.tenant_id,
    approval_row.merchant_id,NEW.request_id,'merchant_settlement_approval','high',
    NEW.request_id,jsonb_build_object('approvalRequestId',NEW.request_id,
      'decisionId',NEW.id,'reason',NEW.reason,'currency',approval_row.currency,
      'grossMinor',approval_row.snapshot_gross_minor,
      'deductionsMinor',approval_row.snapshot_deductions_minor,
      'netMinor',approval_row.snapshot_net_minor)
  );
  RETURN NEW;
END
$function$;
CREATE TRIGGER merchant_settlement_approval_decision_apply
BEFORE INSERT ON merchant_settlement_approval_decisions
FOR EACH ROW EXECUTE FUNCTION apply_merchant_settlement_approval_decision();

CREATE OR REPLACE FUNCTION prevent_merchant_settlement_approval_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'settlement_approval_decisions_are_append_only'
    USING ERRCODE='55000';
END
$function$;
CREATE TRIGGER merchant_settlement_approval_decisions_immutable
BEFORE UPDATE OR DELETE ON merchant_settlement_approval_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_merchant_settlement_approval_decision_mutation();

CREATE OR REPLACE FUNCTION prevent_merchant_settlement_approval_truncate()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'merchant_settlement_approval_history_cannot_be_truncated'
    USING ERRCODE='55000';
END
$function$;
CREATE TRIGGER merchant_settlement_approval_requests_no_truncate
BEFORE TRUNCATE ON merchant_settlement_approval_requests
FOR EACH STATEMENT EXECUTE FUNCTION prevent_merchant_settlement_approval_truncate();
CREATE TRIGGER merchant_settlement_approval_decisions_no_truncate
BEFORE TRUNCATE ON merchant_settlement_approval_decisions
FOR EACH STATEMENT EXECUTE FUNCTION prevent_merchant_settlement_approval_truncate();
