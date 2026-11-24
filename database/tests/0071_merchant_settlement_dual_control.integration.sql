\set ON_ERROR_STOP on
BEGIN;
INSERT INTO merchants (id,tenant_id,legal_name,display_name,country_code,status)
VALUES ('dual-merchant','dual-tenant','Dual Control LLC','Dual Control Merchant','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('dual-branch','dual-merchant','Dual Control Branch','DMM','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('dual-order','platform','dual-customer','dual-order-key','pending_validation','SAR',12000);
INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('dual-suborder','dual-tenant','dual-order','dual-merchant','dual-branch','delivered',12000);
INSERT INTO merchant_settlement_batches
(id,tenant_id,merchant_id,currency,period_start,period_end)
VALUES ('dual-batch','dual-tenant','dual-merchant','SAR',
        '2026-11-01T00:00:00Z','2026-11-15T00:00:00Z');
INSERT INTO merchant_settlement_lines
(id,tenant_id,batch_id,merchant_id,currency,order_id,suborder_id,branch_id,
 contract_reference,gross_minor,deductions_minor,net_minor,deduction_breakdown)
VALUES ('dual-line','dual-tenant','dual-batch','dual-merchant','SAR',
        'dual-order','dual-suborder','dual-branch','approved-contract-v1',
        12000,1000,11000,'[{"code":"platform_fee","amountMinor":1000}]'::jsonb);

INSERT INTO merchant_settlement_approval_requests
(id,tenant_id,batch_id,merchant_id,currency,requested_by,requester_role)
VALUES ('dual-request','dual-tenant','dual-batch','dual-merchant','SAR',
        'finance-requester','finance');

DO $request_snapshot$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM merchant_settlement_approval_requests
    WHERE id='dual-request' AND status='pending'
      AND snapshot_line_count=1 AND snapshot_gross_minor=12000
      AND snapshot_deductions_minor=1000 AND snapshot_net_minor=11000
  ) THEN RAISE EXCEPTION 'approval request snapshot was not captured'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit_events
    WHERE id='settlement-approval-request:dual-request'
      AND event_type='merchant_settlement_approval_requested'
  ) THEN RAISE EXCEPTION 'approval request audit event missing'; END IF;
  BEGIN
    INSERT INTO merchant_settlement_approval_decisions
      (id,tenant_id,request_id,decision,actor_id,actor_role)
    VALUES ('dual-self-decision','dual-tenant','dual-request',
      'authorize_accounting','finance-requester','finance');
    RAISE EXCEPTION 'requester unexpectedly approved own request';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$request_snapshot$;

INSERT INTO merchant_settlement_approval_decisions
(id,tenant_id,request_id,decision,actor_id,actor_role,reason)
VALUES ('dual-decision','dual-tenant','dual-request','authorize_accounting',
        'independent-finance-approver','finance','Reviewed settlement snapshot');

DO $approval_result$
BEGIN
  IF (SELECT status FROM merchant_settlement_approval_requests WHERE id='dual-request')
       <> 'authorized_for_accounting' THEN
    RAISE EXCEPTION 'independent approval did not authorize accounting';
  END IF;
  IF (SELECT status FROM merchant_settlement_batches WHERE id='dual-batch') <> 'draft'
     OR (SELECT journal_id FROM merchant_settlement_batches WHERE id='dual-batch') IS NOT NULL THEN
    RAISE EXCEPTION 'accounting authorization unexpectedly approved or posted settlement';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit_events
    WHERE id='settlement-approval-decision:dual-decision'
      AND event_type='merchant_settlement_accounting_authorized'
      AND actor_id='independent-finance-approver'
  ) THEN RAISE EXCEPTION 'approval decision audit event missing'; END IF;
  BEGIN
    UPDATE merchant_settlement_approval_decisions SET reason='tampered'
    WHERE id='dual-decision';
    RAISE EXCEPTION 'approval decision unexpectedly mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$approval_result$;

ROLLBACK;
