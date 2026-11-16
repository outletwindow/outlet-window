-- Merchant settlement approval requires two distinct active finance-capable humans.
-- This is an accounting approval control; it does not execute a payout.
CREATE TABLE merchant_settlement_approvals (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  batch_id text NOT NULL,
  actor_id text NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision = 'approved'),
  approved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,batch_id)
    REFERENCES merchant_settlement_batches(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,batch_id,actor_id)
);
CREATE INDEX merchant_settlement_approvals_batch_idx
  ON merchant_settlement_approvals(tenant_id,batch_id,approved_at,actor_id);

CREATE OR REPLACE FUNCTION validate_merchant_settlement_approval_actor()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  batch_merchant_id text;
BEGIN
  SELECT merchant_id INTO batch_merchant_id
  FROM merchant_settlement_batches
  WHERE tenant_id=NEW.tenant_id AND id=NEW.batch_id AND status='draft'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_approval_requires_draft_batch'
      USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM identities i
    JOIN role_assignments r ON r.principal_id=i.id
    WHERE i.id=NEW.actor_id
      AND i.principal_type='human'
      AND i.status='active'
      AND r.active=true
      AND r.role IN ('finance','platform_admin','platform_owner')
      AND r.valid_from <= NEW.approved_at
      AND (r.valid_until IS NULL OR r.valid_until > NEW.approved_at)
      AND (
        r.scope->>'platform'='true'
        OR r.scope->>'merchantId'=batch_merchant_id
      )
  ) THEN
    RAISE EXCEPTION 'settlement_approval_actor_lacks_active_finance_scope'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER merchant_settlement_approvals_validate_actor
BEFORE INSERT ON merchant_settlement_approvals
FOR EACH ROW EXECUTE FUNCTION validate_merchant_settlement_approval_actor();

CREATE OR REPLACE FUNCTION guard_merchant_settlement_approval_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'merchant_settlement_approvals_are_append_only'
    USING ERRCODE='55000';
END
$function$;
CREATE TRIGGER merchant_settlement_approvals_no_update_delete
BEFORE UPDATE OR DELETE ON merchant_settlement_approvals
FOR EACH ROW EXECUTE FUNCTION guard_merchant_settlement_approval_mutation();

CREATE OR REPLACE FUNCTION prevent_merchant_settlement_approval_truncate()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'merchant_settlement_approvals_cannot_be_truncated'
    USING ERRCODE='55000';
END
$function$;
CREATE TRIGGER merchant_settlement_approvals_no_truncate
BEFORE TRUNCATE ON merchant_settlement_approvals
FOR EACH STATEMENT EXECUTE FUNCTION prevent_merchant_settlement_approval_truncate();

CREATE OR REPLACE FUNCTION require_dual_merchant_settlement_approval()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE approval_count bigint;
BEGIN
  IF OLD.status='draft' AND NEW.status='approved' THEN
    SELECT COUNT(DISTINCT actor_id) INTO approval_count
    FROM merchant_settlement_approvals
    WHERE tenant_id=OLD.tenant_id AND batch_id=OLD.id
      AND decision='approved';
    IF approval_count < 2 THEN
      RAISE EXCEPTION 'merchant_settlement_requires_two_distinct_finance_approvers'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER merchant_settlement_batches_require_dual_approval
BEFORE UPDATE OF status ON merchant_settlement_batches
FOR EACH ROW EXECUTE FUNCTION require_dual_merchant_settlement_approval();
