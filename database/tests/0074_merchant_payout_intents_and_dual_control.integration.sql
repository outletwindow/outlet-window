\set ON_ERROR_STOP on
BEGIN;

-- The preceding settlement-posting integration test owns a separate transaction.
-- This test uses a small posted journal + approved settlement fixture.
INSERT INTO merchants (id,tenant_id,legal_name,display_name,country_code,status)
VALUES ('payout-merchant','payout-tenant','Payout LLC','Payout Merchant','SA','active');
INSERT INTO financial_accounts
(id,tenant_id,account_code,account_name,account_type,currency)
VALUES ('payout-held','payout-tenant','CUSTOMER_FUNDS_HELD','Customer funds held','liability','SAR'),
       ('payout-payable','payout-tenant','MERCHANT_PAYABLE','Merchant payable','liability','SAR');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('payout-branch','payout-merchant','Payout Branch','JUB','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('payout-order','payout-tenant','payout-customer','payout-order-key','pending_validation','SAR',5000);
INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('payout-suborder','payout-tenant','payout-order','payout-merchant','payout-branch','delivered',5000);
INSERT INTO financial_journals
(id,tenant_id,idempotency_key,source_type,source_reference,currency,description,status,occurred_at)
VALUES ('payout-settlement-journal','payout-tenant','payout-settlement-journal-key',
 'merchant_settlement','payout-batch','SAR','Settlement posting fixture','draft','2026-11-25T08:00:00Z');
INSERT INTO financial_journal_lines
(id,tenant_id,journal_id,account_id,currency,line_number,debit_minor,credit_minor,memo)
VALUES ('payout-journal-line-1','payout-tenant','payout-settlement-journal','payout-held','SAR',1,5000,0,'Held'),
       ('payout-journal-line-2','payout-tenant','payout-settlement-journal','payout-payable','SAR',2,0,5000,'Payable');
UPDATE financial_journals SET status='posted' WHERE id='payout-settlement-journal';

INSERT INTO merchant_settlement_batches
(id,tenant_id,merchant_id,currency,period_start,period_end)
VALUES ('payout-batch','payout-tenant','payout-merchant','SAR',
 '2026-11-01T00:00:00Z','2026-11-15T00:00:00Z');
INSERT INTO merchant_settlement_lines
(id,tenant_id,batch_id,merchant_id,currency,order_id,suborder_id,branch_id,
 contract_reference,gross_minor,deductions_minor,net_minor,deduction_breakdown)
VALUES ('payout-line','payout-tenant','payout-batch','payout-merchant','SAR',
 'payout-order','payout-suborder','payout-branch','payout-contract',5000,0,5000,'[]'::jsonb);
UPDATE merchant_settlement_batches
SET journal_id='payout-settlement-journal',status='approved'
WHERE tenant_id='payout-tenant' AND id='payout-batch';

DO $checks$
BEGIN
  INSERT INTO merchant_payout_intents
    (id,tenant_id,merchant_id,currency,settlement_batch_id,amount_minor,idempotency_key,requested_by,requester_role)
  VALUES ('payout-intent','payout-tenant','payout-merchant','SAR','payout-batch',5000,
    'payout-idempotency-1','payout-operations','operations');

  BEGIN
    INSERT INTO merchant_payout_decisions
      (id,tenant_id,payout_intent_id,decision,actor_id,actor_role)
    VALUES ('payout-self-decision','payout-tenant','payout-intent','authorize',
      'payout-operations','finance');
    RAISE EXCEPTION 'payout requester unexpectedly approved own request';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  INSERT INTO merchant_payout_decisions
    (id,tenant_id,payout_intent_id,decision,actor_id,actor_role)
  VALUES ('payout-independent-decision','payout-tenant','payout-intent','authorize',
    'payout-finance','finance');

  IF (SELECT status FROM merchant_payout_intents WHERE id='payout-intent')<>'authorized' THEN
    RAISE EXCEPTION 'independent payout authorization was not recorded';
  END IF;
  IF EXISTS (SELECT 1 FROM merchant_payout_intents WHERE id='payout-intent'
      AND (status='submitted' OR status='confirmed')) THEN
    RAISE EXCEPTION 'authorization must not imply money movement';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_events
    WHERE id='merchant-payout-decision:payout-tenant:payout-independent-decision'
      AND actor_id='payout-finance') THEN
    RAISE EXCEPTION 'payout approval audit event missing';
  END IF;
END
$checks$;

ROLLBACK;
