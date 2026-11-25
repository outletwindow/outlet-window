-- Immutable contract-policy snapshots and deduction-to-ledger account bindings.
-- This is configuration evidence for accounting; it never moves money.

CREATE TABLE merchant_settlement_policy_snapshots (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  merchant_id text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  contract_reference text NOT NULL CHECK (length(trim(contract_reference)) BETWEEN 1 AND 240),
  policy_version text NOT NULL CHECK (length(trim(policy_version)) BETWEEN 1 AND 120),
  policy_sha256 char(64) NOT NULL CHECK (policy_sha256 ~ '^[a-f0-9]{64}$'),
  policy_payload jsonb NOT NULL CHECK (jsonb_typeof(policy_payload)='object'),
  approved_by text NOT NULL CHECK (length(trim(approved_by)) BETWEEN 1 AND 160),
  approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,merchant_id)
    REFERENCES merchants (tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,id,merchant_id,currency),
  UNIQUE (tenant_id,id,merchant_id,currency,contract_reference),
  UNIQUE (tenant_id,merchant_id,currency,contract_reference,policy_version)
);

CREATE TABLE merchant_settlement_deduction_account_mappings (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  policy_snapshot_id text NOT NULL,
  merchant_id text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  contract_reference text NOT NULL,
  deduction_code text NOT NULL CHECK (deduction_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  account_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,policy_snapshot_id,merchant_id,currency,contract_reference)
    REFERENCES merchant_settlement_policy_snapshots
      (tenant_id,id,merchant_id,currency,contract_reference) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,account_id,currency)
    REFERENCES financial_accounts (tenant_id,id,currency) ON DELETE RESTRICT,
  UNIQUE (tenant_id,policy_snapshot_id,deduction_code),
  UNIQUE (tenant_id,id,policy_snapshot_id)
);
CREATE INDEX merchant_settlement_deduction_mapping_account_idx
  ON merchant_settlement_deduction_account_mappings (tenant_id,account_id,currency);

ALTER TABLE merchant_settlement_batches
  ADD COLUMN policy_snapshot_id text;

ALTER TABLE merchant_settlement_batches
  ADD CONSTRAINT merchant_settlement_batch_policy_snapshot_fk
  FOREIGN KEY (tenant_id,policy_snapshot_id,merchant_id,currency)
  REFERENCES merchant_settlement_policy_snapshots
    (tenant_id,id,merchant_id,currency) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION guard_merchant_settlement_policy_snapshot_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.policy_snapshot_id IS NOT NULL
     AND NEW.policy_snapshot_id IS DISTINCT FROM OLD.policy_snapshot_id THEN
    RAISE EXCEPTION 'merchant_settlement_policy_snapshot_binding_is_immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.policy_snapshot_id IS NULL AND NEW.policy_snapshot_id IS NOT NULL
     AND (OLD.status <> 'draft' OR NEW.status <> 'draft') THEN
    RAISE EXCEPTION 'merchant_settlement_policy_snapshot_requires_draft_batch'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER merchant_settlement_batches_policy_snapshot_guard
BEFORE UPDATE OF policy_snapshot_id ON merchant_settlement_batches
FOR EACH ROW EXECUTE FUNCTION guard_merchant_settlement_policy_snapshot_binding();

CREATE OR REPLACE FUNCTION validate_merchant_settlement_line_policy_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound_contract_reference text;
BEGIN
  SELECT policy.contract_reference INTO bound_contract_reference
  FROM merchant_settlement_batches batch
  JOIN merchant_settlement_policy_snapshots policy
    ON policy.tenant_id=batch.tenant_id
   AND policy.id=batch.policy_snapshot_id
   AND policy.merchant_id=batch.merchant_id
   AND policy.currency=batch.currency
  WHERE batch.tenant_id=NEW.tenant_id AND batch.id=NEW.batch_id
  FOR UPDATE OF batch;
  IF FOUND AND bound_contract_reference IS DISTINCT FROM NEW.contract_reference THEN
    RAISE EXCEPTION 'merchant_settlement_line_contract_policy_mismatch'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER merchant_settlement_lines_policy_snapshot_guard
BEFORE INSERT ON merchant_settlement_lines
FOR EACH ROW EXECUTE FUNCTION validate_merchant_settlement_line_policy_snapshot();

CREATE OR REPLACE FUNCTION prevent_merchant_settlement_policy_configuration_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'merchant_settlement_policy_configuration_is_immutable'
    USING ERRCODE='55000';
END
$$;
CREATE TRIGGER merchant_settlement_policy_snapshots_immutable
BEFORE UPDATE OR DELETE ON merchant_settlement_policy_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_merchant_settlement_policy_configuration_mutation();
CREATE TRIGGER merchant_settlement_deduction_mappings_immutable
BEFORE UPDATE OR DELETE ON merchant_settlement_deduction_account_mappings
FOR EACH ROW EXECUTE FUNCTION prevent_merchant_settlement_policy_configuration_mutation();

CREATE OR REPLACE FUNCTION prevent_merchant_settlement_policy_configuration_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'merchant_settlement_policy_configuration_cannot_be_truncated'
    USING ERRCODE='55000';
END
$$;
CREATE TRIGGER merchant_settlement_policy_snapshots_no_truncate
BEFORE TRUNCATE ON merchant_settlement_policy_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION prevent_merchant_settlement_policy_configuration_truncate();
CREATE TRIGGER merchant_settlement_deduction_mappings_no_truncate
BEFORE TRUNCATE ON merchant_settlement_deduction_account_mappings
FOR EACH STATEMENT EXECUTE FUNCTION prevent_merchant_settlement_policy_configuration_truncate();
