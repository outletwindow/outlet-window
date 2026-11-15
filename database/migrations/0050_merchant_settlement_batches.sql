-- Draft merchant settlement batches. Approval records ledger reclassification only; it never pays out funds.
CREATE TABLE merchant_settlement_batches (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  merchant_id text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  journal_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  FOREIGN KEY (tenant_id,merchant_id) REFERENCES merchants (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,journal_id,currency)
    REFERENCES financial_journals (tenant_id,id,currency) ON DELETE RESTRICT,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,id,merchant_id,currency),
  UNIQUE (tenant_id,merchant_id,currency,period_start,period_end),
  CHECK (period_end > period_start),
  CHECK ((status='draft' AND approved_at IS NULL) OR
         (status='approved' AND approved_at IS NOT NULL AND journal_id IS NOT NULL))
);

CREATE TABLE merchant_settlement_lines (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  batch_id text NOT NULL,
  merchant_id text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  order_id text NOT NULL,
  suborder_id text NOT NULL,
  branch_id text NOT NULL,
  contract_reference text NOT NULL CHECK (length(trim(contract_reference)) BETWEEN 1 AND 240),
  gross_minor bigint NOT NULL CHECK (gross_minor > 0),
  deductions_minor bigint NOT NULL DEFAULT 0 CHECK (deductions_minor >= 0),
  net_minor bigint NOT NULL CHECK (net_minor > 0),
  deduction_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(deduction_breakdown)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,batch_id,merchant_id,currency)
    REFERENCES merchant_settlement_batches (tenant_id,id,merchant_id,currency) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id,suborder_id,merchant_id,branch_id)
    REFERENCES merchant_suborders (tenant_id,order_id,id,merchant_id,branch_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,batch_id,suborder_id),
  UNIQUE (tenant_id,suborder_id),
  CHECK (gross_minor = deductions_minor + net_minor),
  CHECK (gross_minor <= 9000000000000000),
  CHECK (deductions_minor <= 9000000000000000),
  CHECK (net_minor <= 9000000000000000)
);
CREATE INDEX merchant_settlement_batches_review_idx
  ON merchant_settlement_batches (tenant_id,status,created_at,id);
CREATE INDEX merchant_settlement_lines_merchant_idx
  ON merchant_settlement_lines (tenant_id,merchant_id,currency,batch_id);

CREATE OR REPLACE FUNCTION validate_merchant_settlement_line()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  suborder_row merchant_suborders%ROWTYPE;
  order_currency char(3);
  breakdown_total numeric := 0;
  item jsonb;
  item_amount numeric;
BEGIN
  SELECT * INTO suborder_row FROM merchant_suborders
   WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id
     AND id=NEW.suborder_id AND merchant_id=NEW.merchant_id
     AND branch_id=NEW.branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merchant_settlement_suborder_not_found' USING ERRCODE='23503';
  END IF;
  SELECT currency INTO order_currency FROM customer_orders WHERE id=NEW.order_id;
  IF order_currency IS NULL OR order_currency <> NEW.currency THEN
    RAISE EXCEPTION 'merchant_settlement_currency_mismatch' USING ERRCODE='23514';
  END IF;
  IF suborder_row.subtotal_minor <> NEW.gross_minor THEN
    RAISE EXCEPTION 'merchant_settlement_gross_must_match_suborder_subtotal'
      USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.deduction_breakdown)
  LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
       OR jsonb_typeof(item->'code') IS DISTINCT FROM 'string'
       OR length(trim(item->>'code'))=0
       OR jsonb_typeof(item->'amountMinor') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'merchant_settlement_deduction_item_invalid' USING ERRCODE='23514';
    END IF;
    item_amount := (item->>'amountMinor')::numeric;
    IF item_amount <= 0 OR item_amount <> trunc(item_amount) THEN
      RAISE EXCEPTION 'merchant_settlement_deduction_amount_invalid' USING ERRCODE='23514';
    END IF;
    breakdown_total := breakdown_total + item_amount;
  END LOOP;
  IF breakdown_total <> NEW.deductions_minor THEN
    RAISE EXCEPTION 'merchant_settlement_deduction_breakdown_mismatch'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER merchant_settlement_lines_validate
BEFORE INSERT ON merchant_settlement_lines
FOR EACH ROW EXECUTE FUNCTION validate_merchant_settlement_line();

CREATE OR REPLACE FUNCTION guard_merchant_settlement_line_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_status text;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'merchant_settlement_lines_are_append_only' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT status INTO batch_status FROM merchant_settlement_batches
     WHERE tenant_id=NEW.tenant_id AND id=NEW.batch_id;
    IF batch_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'merchant_settlement_lines_require_draft_batch' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO batch_status FROM merchant_settlement_batches
   WHERE tenant_id=OLD.tenant_id AND id=OLD.batch_id;
  IF batch_status='approved' THEN
    RAISE EXCEPTION 'approved_merchant_settlement_lines_are_immutable' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER merchant_settlement_lines_no_update_delete
BEFORE INSERT OR UPDATE OR DELETE ON merchant_settlement_lines
FOR EACH ROW EXECUTE FUNCTION guard_merchant_settlement_line_mutation();

CREATE OR REPLACE FUNCTION validate_merchant_settlement_batch_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_count bigint;
  gross_total numeric;
  deductions_total numeric;
  net_total numeric;
  journal_row financial_journals%ROWTYPE;
  held_account_id text;
  payable_account_id text;
  journal_debit numeric;
  payable_credit numeric;
  other_credit numeric;
  journal_line_count bigint;
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.merchant_id IS DISTINCT FROM NEW.merchant_id
     OR OLD.currency IS DISTINCT FROM NEW.currency
     OR OLD.period_start IS DISTINCT FROM NEW.period_start
     OR OLD.period_end IS DISTINCT FROM NEW.period_end
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'merchant_settlement_batch_identity_is_immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='approved' THEN
    RAISE EXCEPTION 'merchant_settlement_batch_is_immutable_after_approval' USING ERRCODE='55000';
  END IF;
  IF OLD.status <> 'draft' OR NEW.status <> 'approved' THEN
    RAISE EXCEPTION 'merchant_settlement_batch_only_supports_draft_to_approved'
      USING ERRCODE='23514';
  END IF;
  IF NEW.journal_id IS NULL THEN
    RAISE EXCEPTION 'merchant_settlement_approval_requires_journal' USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*),COALESCE(SUM(gross_minor),0),
         COALESCE(SUM(deductions_minor),0),COALESCE(SUM(net_minor),0)
    INTO line_count,gross_total,deductions_total,net_total
  FROM merchant_settlement_lines
  WHERE tenant_id=OLD.tenant_id AND batch_id=OLD.id;
  IF line_count=0 OR gross_total <> deductions_total + net_total THEN
    RAISE EXCEPTION 'merchant_settlement_batch_totals_invalid' USING ERRCODE='23514';
  END IF;

  SELECT * INTO journal_row FROM financial_journals
   WHERE tenant_id=OLD.tenant_id AND id=NEW.journal_id AND currency=OLD.currency;
  IF NOT FOUND OR journal_row.status <> 'posted'
     OR journal_row.source_type <> 'merchant_settlement'
     OR journal_row.source_reference <> OLD.id THEN
    RAISE EXCEPTION 'merchant_settlement_requires_matching_posted_journal'
      USING ERRCODE='23514';
  END IF;

  SELECT id INTO held_account_id FROM financial_accounts
   WHERE tenant_id=OLD.tenant_id AND currency=OLD.currency
     AND account_code='CUSTOMER_FUNDS_HELD' AND account_type='liability' AND is_active;
  SELECT id INTO payable_account_id FROM financial_accounts
   WHERE tenant_id=OLD.tenant_id AND currency=OLD.currency
     AND account_code='MERCHANT_PAYABLE' AND account_type='liability' AND is_active;
  IF held_account_id IS NULL OR payable_account_id IS NULL THEN
    RAISE EXCEPTION 'merchant_settlement_required_accounts_missing' USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*),
         COALESCE(SUM(debit_minor) FILTER (WHERE account_id=held_account_id),0),
         COALESCE(SUM(credit_minor) FILTER (WHERE account_id=payable_account_id),0),
         COALESCE(SUM(credit_minor) FILTER (WHERE account_id<>payable_account_id),0)
    INTO journal_line_count,journal_debit,payable_credit,other_credit
  FROM financial_journal_lines
  WHERE tenant_id=OLD.tenant_id AND journal_id=NEW.journal_id AND currency=OLD.currency;
  IF journal_line_count < 2 OR journal_debit <> gross_total
     OR payable_credit <> net_total OR other_credit <> deductions_total
     OR EXISTS (
       SELECT 1 FROM financial_journal_lines
       WHERE tenant_id=OLD.tenant_id AND journal_id=NEW.journal_id AND currency=OLD.currency
         AND ((account_id=held_account_id AND credit_minor>0)
           OR (account_id=payable_account_id AND debit_minor>0))
     ) THEN
    RAISE EXCEPTION 'merchant_settlement_journal_amounts_mismatch' USING ERRCODE='23514';
  END IF;
  NEW.approved_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER merchant_settlement_batches_validate_approval
BEFORE UPDATE OF status ON merchant_settlement_batches
FOR EACH ROW EXECUTE FUNCTION validate_merchant_settlement_batch_approval();

CREATE OR REPLACE FUNCTION guard_merchant_settlement_batch_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (
       OLD.id IS DISTINCT FROM NEW.id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.merchant_id IS DISTINCT FROM NEW.merchant_id
       OR OLD.currency IS DISTINCT FROM NEW.currency
       OR OLD.period_start IS DISTINCT FROM NEW.period_start
       OR OLD.period_end IS DISTINCT FROM NEW.period_end
       OR OLD.created_at IS DISTINCT FROM NEW.created_at) THEN
    RAISE EXCEPTION 'merchant_settlement_batch_identity_is_immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='approved' THEN
    RAISE EXCEPTION 'merchant_settlement_batch_is_immutable_after_approval' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER merchant_settlement_batches_no_delete_approved
BEFORE UPDATE OR DELETE ON merchant_settlement_batches
FOR EACH ROW EXECUTE FUNCTION guard_merchant_settlement_batch_mutation();

CREATE OR REPLACE FUNCTION prevent_merchant_settlement_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'merchant_settlement_tables_cannot_be_truncated' USING ERRCODE='55000';
END $$;
CREATE TRIGGER merchant_settlement_batches_no_truncate
BEFORE TRUNCATE ON merchant_settlement_batches
FOR EACH STATEMENT EXECUTE FUNCTION prevent_merchant_settlement_truncate();
CREATE TRIGGER merchant_settlement_lines_no_truncate
BEFORE TRUNCATE ON merchant_settlement_lines
FOR EACH STATEMENT EXECUTE FUNCTION prevent_merchant_settlement_truncate();
