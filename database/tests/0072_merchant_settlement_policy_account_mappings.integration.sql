\set ON_ERROR_STOP on
BEGIN;

INSERT INTO merchants (id,tenant_id,legal_name,display_name,country_code,status)
VALUES ('policy-merchant','policy-tenant','Policy LLC','Policy Merchant','SA','active');
INSERT INTO financial_accounts
(id,tenant_id,account_code,account_name,account_type,currency)
VALUES ('policy-fee-account','policy-tenant','PLATFORM_FEE_REVENUE','Platform fee','revenue','SAR');

INSERT INTO merchant_settlement_policy_snapshots
(id,tenant_id,merchant_id,currency,contract_reference,policy_version,
 policy_sha256,policy_payload,approved_by,approved_at)
VALUES ('policy-snapshot-v1','policy-tenant','policy-merchant','SAR',
 'contract-2026-v1','v1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 '{"commissionRateBps":500,"taxMode":"exclusive"}'::jsonb,
 'finance-approver','2026-11-25T08:00:00Z');

INSERT INTO merchant_settlement_deduction_account_mappings
(id,tenant_id,policy_snapshot_id,merchant_id,currency,contract_reference,deduction_code,account_id)
VALUES ('policy-map-fee','policy-tenant','policy-snapshot-v1','policy-merchant','SAR',
 'contract-2026-v1','platform_fee','policy-fee-account');

INSERT INTO merchant_settlement_batches
(id,tenant_id,merchant_id,currency,period_start,period_end,policy_snapshot_id)
VALUES ('policy-batch','policy-tenant','policy-merchant','SAR',
 '2026-11-01T00:00:00Z','2026-11-15T00:00:00Z','policy-snapshot-v1');

DO $checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM merchant_settlement_deduction_account_mappings
    WHERE tenant_id='policy-tenant' AND policy_snapshot_id='policy-snapshot-v1'
      AND deduction_code='platform_fee' AND account_id='policy-fee-account'
  ) THEN RAISE EXCEPTION 'policy deduction account mapping missing'; END IF;

  BEGIN
    INSERT INTO merchant_settlement_deduction_account_mappings
    (id,tenant_id,policy_snapshot_id,merchant_id,currency,contract_reference,deduction_code,account_id)
    VALUES ('policy-map-duplicate','policy-tenant','policy-snapshot-v1','policy-merchant','SAR',
      'contract-2026-v1','platform_fee','policy-fee-account');
    RAISE EXCEPTION 'duplicate deduction mapping unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    UPDATE merchant_settlement_policy_snapshots SET policy_version='v2'
    WHERE id='policy-snapshot-v1';
    RAISE EXCEPTION 'policy snapshot unexpectedly mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE merchant_settlement_deduction_account_mappings SET account_id='missing-account'
    WHERE id='policy-map-fee';
    RAISE EXCEPTION 'deduction mapping unexpectedly mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE merchant_settlement_batches SET policy_snapshot_id=NULL WHERE id='policy-batch';
    RAISE EXCEPTION 'policy snapshot binding unexpectedly mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$checks$;

ROLLBACK;
