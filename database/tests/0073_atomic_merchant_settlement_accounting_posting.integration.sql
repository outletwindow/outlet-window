\set ON_ERROR_STOP on
BEGIN;

INSERT INTO merchants (id,tenant_id,legal_name,display_name,country_code,status)
VALUES ('posting-merchant','posting-tenant','Posting LLC','Posting Merchant','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('posting-branch','posting-merchant','Posting Branch','JUB','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('posting-order','platform','posting-customer','posting-order-key','pending_validation','SAR',12000);
INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('posting-suborder','posting-tenant','posting-order','posting-merchant','posting-branch','delivered',12000);
INSERT INTO financial_accounts
(id,tenant_id,account_code,account_name,account_type,currency)
VALUES ('posting-held','posting-tenant','CUSTOMER_FUNDS_HELD','Customer funds held','liability','SAR'),
       ('posting-payable','posting-tenant','MERCHANT_PAYABLE','Merchant payable','liability','SAR'),
       ('posting-fee','posting-tenant','PLATFORM_FEE_REVENUE','Platform fee','revenue','SAR');

INSERT INTO merchant_settlement_policy_snapshots
(id,tenant_id,merchant_id,currency,contract_reference,policy_version,
 policy_sha256,policy_payload,approved_by,approved_at)
VALUES ('posting-policy','posting-tenant','posting-merchant','SAR',
 'posting-contract-v1','v1','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
 '{"commissionRateBps":500}'::jsonb,'policy-approver','2026-11-25T08:00:00Z');

INSERT INTO merchant_settlement_deduction_account_mappings
(id,tenant_id,policy_snapshot_id,merchant_id,currency,contract_reference,deduction_code,account_id)
VALUES ('posting-map-fee','posting-tenant','posting-policy','posting-merchant','SAR',
 'posting-contract-v1','platform_fee','posting-fee');

INSERT INTO merchant_settlement_batches
(id,tenant_id,merchant_id,currency,period_start,period_end,policy_snapshot_id)
VALUES ('posting-batch','posting-tenant','posting-merchant','SAR',
 '2026-11-01T00:00:00Z','2026-11-15T00:00:00Z','posting-policy');

INSERT INTO merchant_settlement_lines
(id,tenant_id,batch_id,merchant_id,currency,order_id,suborder_id,branch_id,
 contract_reference,gross_minor,deductions_minor,net_minor,deduction_breakdown)
VALUES ('posting-line','posting-tenant','posting-batch','posting-merchant','SAR',
 'posting-order','posting-suborder','posting-branch','posting-contract-v1',
 12000,1000,11000,'[{"code":"platform_fee","amountMinor":1000}]'::jsonb);

INSERT INTO merchant_settlement_approval_requests
(id,tenant_id,batch_id,merchant_id,currency,requested_by,requester_role)
VALUES ('posting-approval','posting-tenant','posting-batch','posting-merchant','SAR',
 'posting-requester','operations');
INSERT INTO merchant_settlement_approval_decisions
(id,tenant_id,request_id,decision,actor_id,actor_role,reason)
VALUES ('posting-decision','posting-tenant','posting-approval','authorize_accounting',
 'posting-reviewer','finance','Independent review');

DO $posting$
DECLARE
  first_journal text;
  retry_journal text;
BEGIN
  first_journal := post_merchant_settlement_accounting(
    'posting-tenant','posting-batch','posting-finance','finance');
  retry_journal := post_merchant_settlement_accounting(
    'posting-tenant','posting-batch','posting-finance','finance');
  IF first_journal IS NULL OR first_journal<>retry_journal THEN
    RAISE EXCEPTION 'idempotent settlement posting did not return the same journal';
  END IF;
  IF (SELECT status FROM merchant_settlement_batches WHERE id='posting-batch')<>'approved'
     OR (SELECT journal_id FROM merchant_settlement_batches WHERE id='posting-batch')<>first_journal THEN
    RAISE EXCEPTION 'settlement batch was not atomically linked to posted journal';
  END IF;
  IF (SELECT status FROM financial_journals WHERE id=first_journal)<>'posted' THEN
    RAISE EXCEPTION 'settlement journal was not posted';
  END IF;
  IF (SELECT SUM(debit_minor) FROM financial_journal_lines WHERE journal_id=first_journal)<>12000
     OR (SELECT SUM(credit_minor) FROM financial_journal_lines WHERE journal_id=first_journal)<>12000 THEN
    RAISE EXCEPTION 'settlement journal is not balanced';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit_events
    WHERE id='settlement-accounting-posted:posting-tenant:posting-batch'
      AND event_type='merchant_settlement_accounting_posted'
      AND actor_id='posting-finance'
  ) THEN RAISE EXCEPTION 'accounting posting audit event missing'; END IF;

  BEGIN
    PERFORM post_merchant_settlement_accounting(
      'posting-tenant','posting-batch','posting-requester','finance');
    RAISE EXCEPTION 'requester unexpectedly posted own settlement';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$posting$;

ROLLBACK;
