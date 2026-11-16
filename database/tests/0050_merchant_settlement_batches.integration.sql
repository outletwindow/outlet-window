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
INSERT INTO identities
(id,principal_type,status,display_name,primary_email,created_at,updated_at)
VALUES
('settle-finance-1','human','active','Finance Approver One','finance1@example.test',now(),now()),
('settle-finance-2','human','active','Finance Approver Two','finance2@example.test',now(),now()),
('settle-courier','human','active','Courier Principal','courier@example.test',now(),now());
INSERT INTO role_assignments
(id,principal_id,role,scope,active,valid_from,assigned_by)
VALUES
('settle-finance-role-1','settle-finance-1','finance','{"merchantId":"settle-merchant"}'::jsonb,true,now()-interval '1 day','test-admin'),
('settle-finance-role-2','settle-finance-2','finance','{"merchantId":"settle-merchant"}'::jsonb,true,now()-interval '1 day','test-admin'),
('settle-courier-role','settle-courier','courier','{"merchantId":"settle-merchant"}'::jsonb,true,now()-interval '1 day','test-admin');
INSERT INTO merchant_settlement_approvals
(id,tenant_id,batch_id,actor_id,decision)
VALUES
('settle-approval-1','settle-tenant','settle-batch','settle-finance-1','approved'),
('settle-approval-2','settle-tenant','settle-batch','settle-finance-2','approved');
UPDATE merchant_settlement_batches SET journal_id='settle-journal',status='approved' WHERE id='settle-batch';

DO $$
BEGIN
  IF (SELECT status FROM merchant_settlement_batches WHERE id='settle-batch') <> 'approved' THEN
    RAISE EXCEPTION 'settlement batch was not approved';
  END IF;
  IF (SELECT approved_at IS NULL FROM merchant_settlement_batches WHERE id='settle-batch') THEN
    RAISE EXCEPTION 'settlement approval timestamp missing';
  END IF;
  IF (SELECT COUNT(*) FROM audit_events
      WHERE event_type='merchant_settlement.approved'
        AND resource_id='settle-batch') <> 2 THEN
    RAISE EXCEPTION 'each finance approval must create immutable audit evidence';
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
    UPDATE merchant_settlement_approvals SET decision='approved'
    WHERE id='settle-approval-1';
    RAISE EXCEPTION 'settlement approval unexpectedly updated';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    DELETE FROM merchant_settlement_approvals WHERE id='settle-approval-1';
    RAISE EXCEPTION 'settlement approval unexpectedly deleted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    TRUNCATE merchant_settlement_lines;
    RAISE EXCEPTION 'settlement lines unexpectedly truncated';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;

INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('settle-order-2','platform','settle-customer','settle-order-key-2','pending_validation','SAR',12000);
INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('settle-suborder-2','settle-tenant','settle-order-2','settle-merchant','settle-branch','delivered',12000);
INSERT INTO merchant_settlement_batches
(id,tenant_id,merchant_id,currency,period_start,period_end)
VALUES ('settle-batch-invalid','settle-tenant','settle-merchant','SAR',
        '2026-11-15T00:00:00Z','2026-11-16T00:00:00Z');
INSERT INTO merchant_settlement_lines
(id,tenant_id,batch_id,merchant_id,currency,order_id,suborder_id,branch_id,
 contract_reference,gross_minor,deductions_minor,net_minor,deduction_breakdown)
VALUES ('settle-line-invalid','settle-tenant','settle-batch-invalid','settle-merchant','SAR',
        'settle-order-2','settle-suborder-2','settle-branch','approved-contract-v1',
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
INSERT INTO merchant_settlement_approvals
(id,tenant_id,batch_id,actor_id,decision)
VALUES ('settle-approval-invalid-1','settle-tenant','settle-batch-invalid','settle-finance-1','approved');
DO $settlement_batch_test$
BEGIN
  BEGIN
    INSERT INTO merchant_settlement_approvals
    (id,tenant_id,batch_id,actor_id,decision)
    VALUES ('settle-approval-unauthorized','settle-tenant','settle-batch-invalid','settle-courier','approved');
    RAISE EXCEPTION 'non-finance actor unexpectedly approved a settlement';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE merchant_settlement_batches
    SET journal_id='settle-journal-invalid',status='approved'
    WHERE id='settle-batch-invalid';
    RAISE EXCEPTION 'settlement batch unexpectedly approved with only one approver';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO merchant_settlement_approvals
    (id,tenant_id,batch_id,actor_id,decision)
    VALUES ('settle-approval-invalid-2','settle-tenant','settle-batch-invalid','settle-finance-2','approved');
  END;
  BEGIN
    UPDATE merchant_settlement_batches
    SET journal_id='settle-journal-invalid',status='approved'
    WHERE id='settle-batch-invalid';
    RAISE EXCEPTION 'incorrect settlement journal unexpectedly approved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE merchant_settlement_batches
    SET journal_id='settle-journal'
    WHERE id='settle-batch-invalid';
    RAISE EXCEPTION 'draft settlement batch unexpectedly reserved a journal';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF position('FOR UPDATE' IN upper(pg_get_functiondef(
       'guard_merchant_settlement_line_mutation()'::regprocedure
     ))) = 0 THEN
    RAISE EXCEPTION 'settlement line mutations must lock the parent batch before checking draft status';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname=current_schema()
      AND indexname='merchant_settlement_batches_journal_once_idx'
  ) THEN
    RAISE EXCEPTION 'settlement journal single-use index missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='merchant_settlement_batch_journal_status_check'
      AND conrelid='merchant_settlement_batches'::regclass
  ) THEN
    RAISE EXCEPTION 'settlement journal status constraint missing';
  END IF;
END $settlement_batch_test$;
ROLLBACK;
