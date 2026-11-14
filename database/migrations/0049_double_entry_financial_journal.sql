-- Double-entry financial journal foundation. A journal is immutable after posting.
CREATE TABLE financial_accounts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  account_code text NOT NULL CHECK (length(trim(account_code)) BETWEEN 1 AND 80),
  account_name text NOT NULL CHECK (length(trim(account_name)) BETWEEN 1 AND 200),
  account_type text NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,account_code,currency),
  UNIQUE (tenant_id,id,currency)
);

CREATE TABLE financial_journals (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 240),
  source_type text NOT NULL CHECK (length(trim(source_type)) BETWEEN 1 AND 80),
  source_reference text NOT NULL CHECK (length(trim(source_reference)) BETWEEN 1 AND 240),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
  occurred_at timestamptz NOT NULL,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key),
  CHECK ((status='draft' AND posted_at IS NULL) OR (status='posted' AND posted_at IS NOT NULL))
);
CREATE INDEX financial_journals_source_idx
  ON financial_journals (tenant_id,source_type,source_reference,occurred_at DESC);

CREATE TABLE financial_journal_lines (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  journal_id text NOT NULL,
  account_id text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  line_number integer NOT NULL CHECK (line_number > 0),
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,journal_id)
    REFERENCES financial_journals (tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,account_id,currency)
    REFERENCES financial_accounts (tenant_id,id,currency) ON DELETE RESTRICT,
  UNIQUE (tenant_id,journal_id,line_number),
  CHECK ((debit_minor > 0 AND credit_minor = 0) OR
         (credit_minor > 0 AND debit_minor = 0))
);
CREATE INDEX financial_journal_lines_account_idx
  ON financial_journal_lines (tenant_id,account_id,journal_id);

CREATE OR REPLACE FUNCTION validate_financial_journal_posting()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_count bigint;
  debit_total numeric;
  credit_total numeric;
  inactive_count bigint;
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.source_type IS DISTINCT FROM NEW.source_type
     OR OLD.source_reference IS DISTINCT FROM NEW.source_reference
     OR OLD.currency IS DISTINCT FROM NEW.currency
     OR OLD.occurred_at IS DISTINCT FROM NEW.occurred_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'financial_journal_identity_is_immutable' USING ERRCODE='55000';
  END IF;

  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'financial_journal_is_immutable_after_posting' USING ERRCODE='55000';
  END IF;
  IF OLD.status <> 'draft' OR NEW.status <> 'posted' THEN
    RAISE EXCEPTION 'financial_journal_only_supports_draft_to_posted' USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*),COALESCE(SUM(debit_minor),0),COALESCE(SUM(credit_minor),0)
    INTO line_count,debit_total,credit_total
  FROM financial_journal_lines
  WHERE tenant_id=OLD.tenant_id AND journal_id=OLD.id AND currency=OLD.currency;
  IF line_count < 2 OR debit_total <= 0 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'financial_journal_must_balance_before_posting' USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*) INTO inactive_count
  FROM financial_journal_lines l
  JOIN financial_accounts a
    ON a.tenant_id=l.tenant_id AND a.id=l.account_id AND a.currency=l.currency
  WHERE l.tenant_id=OLD.tenant_id AND l.journal_id=OLD.id AND NOT a.is_active;
  IF inactive_count > 0 THEN
    RAISE EXCEPTION 'financial_journal_uses_inactive_account' USING ERRCODE='23514';
  END IF;

  NEW.posted_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER financial_journals_validate_posting
BEFORE UPDATE OF status ON financial_journals
FOR EACH ROW EXECUTE FUNCTION validate_financial_journal_posting();

CREATE OR REPLACE FUNCTION protect_posted_financial_journal_lines()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  journal_status text;
  scoped_tenant text;
  scoped_journal text;
BEGIN
  scoped_tenant := COALESCE(OLD.tenant_id,NEW.tenant_id);
  scoped_journal := COALESCE(OLD.journal_id,NEW.journal_id);
  SELECT status INTO journal_status FROM financial_journals
  WHERE tenant_id=scoped_tenant AND id=scoped_journal;
  IF journal_status='posted' THEN
    RAISE EXCEPTION 'financial_journal_lines_are_immutable_after_posting'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER financial_journal_lines_immutable_after_posting
BEFORE UPDATE OR DELETE ON financial_journal_lines
FOR EACH ROW EXECUTE FUNCTION protect_posted_financial_journal_lines();

CREATE OR REPLACE FUNCTION prevent_financial_journal_lines_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financial_journal_lines_cannot_be_truncated' USING ERRCODE='55000';
END $$;
CREATE TRIGGER financial_journal_lines_no_truncate
BEFORE TRUNCATE ON financial_journal_lines
FOR EACH STATEMENT EXECUTE FUNCTION prevent_financial_journal_lines_truncate();

CREATE OR REPLACE FUNCTION protect_posted_financial_journals()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='posted' THEN
    RAISE EXCEPTION 'financial_journal_is_immutable_after_posting' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_journals_no_delete_posted
BEFORE UPDATE OR DELETE ON financial_journals
FOR EACH ROW EXECUTE FUNCTION protect_posted_financial_journals();
