\set ON_ERROR_STOP on
BEGIN;
INSERT INTO merchants (id,tenant_id,legal_name,display_name,country_code,status)
VALUES ('settle-merchant','settle-tenant','Settlement LLC','Settlement Merchant','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('settle-branch','settle-merchant','Settlement Branch','JUB','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('settle-order','platform','settle-customer','settle-order-key','pending_validation','SAR',12000);
INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('settle-suborder','settle-tenant','settle-order','settle-merchant','settle-branch','delivered',12000);
INSERT INTO financial_accounts (id,tenant_id,account_code,account_name,account_type,currency)
VALUES ('settle-held','settle-tenant','CUSTOMER_FUNDS_HELD','Customer funds held','liability','SAR'),
       ('settle-payable','settle-tenant','MERCHANT_PAYABLE','Merchant payable','liability','SAR'),
       ('settle-fee','settle-tenant','PLATFORM_FEE_REVENUE','Platform fee revenue','revenue','SAR');
INSERT INTO merchant_settlement_batches
(id,tenant_id,merchant_id,currency,period_start,period_end)
VALUES ('settle-batch','settle-tenant','settle-merchant','SAR',
        '2026-11-01T00:00:00Z','2026-11-15T00:00:00Z');
INSERT INTO merchant_settlement_lines
(id,tenant_id,batch_id,merchant_id,currency,order_id,suborder_id,branch_id,
 contract_reference,gross_minor,deductions_minor,net_minor,deduction_breakdown)
VALUES ('settle-line','settle-tenant','settle-batch','settle-merchant','SAR',
        'settle-order','settle-suborder','settle-branch','approved-contract-v1',
        12000,1000,11000,'[{"code":"platform_fee","amountMinor":1000}]'::jsonb);
INSERT INTO financial_journals
(id,tenant_id,idempotency_key,source_type,source_reference,currency,description,occurred_at)
VALUES ('settle-journal','settle-tenant','settlement-journal:batch-1','merchant_settlement',
        'settle-batch','SAR','Merchant settlement approval','2026-11-15T00:00:00Z');
INSERT INTO financial_journal_lines
(id,tenant_id,journal_id,account_id,currency,line_number,debit_minor,credit_minor)
VALUES ('settle-journal-line-1','settle-tenant','settle-journal','settle-held','SAR',1,12000,0),
       ('settle-journal-line-2','settle-tenant','settle-journal','settle-payable','SAR',2,0,11000),
       ('settle-journal-line-3','settle-tenant','settle-journal','settle-fee','SAR',3,0,1000);
UPDATE financial_journals SET status='posted' WHERE id='settle-journal';
UPDATE merchant_settlement_batches SET journal_id='settle-journal',status='approved' WHERE id='settle-batch';

DO $$
BEGIN
  IF (SELECT status FROM merchant_settlement_batches WHERE id='settle-batch') <> 'approved' THEN
    RAISE EXCEPTION 'settlement batch was not approved';
  END IF;
  IF (SELECT approved_at IS NULL FROM merchant_settlement_batches WHERE id='settle-batch') THEN
    RAISE EXCEPTION 'settlement approval timestamp missing';
  END IF;
  BEGIN
    INSERT INTO merchant_settlement_lines
    (id,tenant_id,batch_id,merchant_id,currency,order_id,suborder_id,branch_id,
     contract_reference,gross_minor,deductions_minor,net_minor)
    VALUES ('settle-late-line','settle-tenant','settle-batch','settle-merchant','SAR',
            'settle-order','settle-suborder','settle-branch','approved-contract-v1',12000,0,12000);
    RAISE EXCEPTION 'approved settlement batch unexpectedly accepted a line';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    UPDATE merchant_settlement_lines SET net_minor=10000 WHERE id='settle-line';
    RAISE EXCEPTION 'approved settlement line unexpectedly updated';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    DELETE FROM merchant_settlement_lines WHERE id='settle-line';
    RAISE EXCEPTION 'approved settlement line unexpectedly deleted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    UPDATE merchant_settlement_batches SET status='draft' WHERE id='settle-batch';
    RAISE EXCEPTION 'approved settlement batch unexpectedly reverted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    DELETE FROM merchant_settlement_batches WHERE id='settle-batch';
    RAISE EXCEPTION 'approved settlement batch unexpectedly deleted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    TRUNCATE merchant_settlement_lines;
    RAISE EXCEPTION 'settlement lines unexpectedly truncated';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;

INSERT INTO merchant_settlement_batches
(id,tenant_id,merchant_id,currency,period_start,period_end)
VALUES ('settle-batch-invalid','settle-tenant','settle-merchant','SAR',
        '2026-11-15T00:00:00Z','2026-11-16T00:00:00Z');
INSERT INTO merchant_settlement_lines
(id,tenant_id,batch_id,merchant_id,currency,order_id,suborder_id,branch_id,
 contract_reference,gross_minor,deductions_minor,net_minor,deduction_breakdown)
VALUES ('settle-line-invalid','settle-tenant','settle-batch-invalid','settle-merchant','SAR',
        'settle-order','settle-suborder','settle-branch','approved-contract-v1',
        12000,1000,11000,'[{"code":"platform_fee","amountMinor":1000}]'::jsonb);
INSERT INTO financial_journals
(id,tenant_id,idempotency_key,source_type,source_reference,currency,description,occurred_at)
VALUES ('settle-journal-invalid','settle-tenant','settlement-journal:batch-invalid','merchant_settlement',
        'settle-batch-invalid','SAR','Invalid merchant settlement','2026-11-15T00:00:00Z');
INSERT INTO financial_journal_lines
(id,tenant_id,journal_id,account_id,currency,line_number,debit_minor,credit_minor)
VALUES ('settle-invalid-line-1','settle-tenant','settle-journal-invalid','settle-held','SAR',1,12000,0),
       ('settle-invalid-line-2','settle-tenant','settle-journal-invalid','settle-payable','SAR',2,0,10000),
       ('settle-invalid-line-3','settle-tenant','settle-journal-invalid','settle-fee','SAR',3,0,2000);
UPDATE financial_journals SET status='posted' WHERE id='settle-journal-invalid';
DO $$
BEGIN
  BEGIN
    UPDATE merchant_settlement_batches
    SET journal_id='settle-journal-invalid',status='approved'
    WHERE id='settle-batch-invalid';
    RAISE EXCEPTION 'incorrect settlement journal unexpectedly approved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
