\set ON_ERROR_STOP on
BEGIN;

INSERT INTO merchants (id,tenant_id,legal_name,display_name,country_code,status)
VALUES ('payout-outbox-merchant','payout-outbox-tenant','Outbox LLC','Outbox Merchant','SA','active');
INSERT INTO financial_accounts
(id,tenant_id,account_code,account_name,account_type,currency)
VALUES ('payout-outbox-held','payout-outbox-tenant','CUSTOMER_FUNDS_HELD','Customer funds held','liability','SAR'),
       ('payout-outbox-payable','payout-outbox-tenant','MERCHANT_PAYABLE','Merchant payable','liability','SAR');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('payout-outbox-branch','payout-outbox-merchant','Outbox Branch','JUB','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('payout-outbox-order','payout-outbox-tenant','payout-outbox-customer','payout-outbox-order-key','pending_validation','SAR',5000);
INSERT INTO merchant_suborders (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('payout-outbox-suborder','payout-outbox-tenant','payout-outbox-order','payout-outbox-merchant','payout-outbox-branch','delivered',5000);
INSERT INTO financial_journals
(id,tenant_id,idempotency_key,source_type,source_reference,currency,description,status,occurred_at)
VALUES ('payout-outbox-settlement-journal','payout-outbox-tenant','payout-outbox-settlement-journal-key',
 'merchant_settlement','payout-outbox-batch','SAR','Settlement posting fixture','draft','2026-11-25T08:00:00Z');
INSERT INTO financial_journal_lines
(id,tenant_id,journal_id,account_id,currency,line_number,debit_minor,credit_minor,memo)
VALUES ('payout-outbox-journal-line-1','payout-outbox-tenant','payout-outbox-settlement-journal','payout-outbox-held','SAR',1,5000,0,'Held'),
       ('payout-outbox-journal-line-2','payout-outbox-tenant','payout-outbox-settlement-journal','payout-outbox-payable','SAR',2,0,5000,'Payable');
UPDATE financial_journals SET status='posted' WHERE id='payout-outbox-settlement-journal';

INSERT INTO merchant_settlement_batches
(id,tenant_id,merchant_id,currency,period_start,period_end)
VALUES ('payout-outbox-batch','payout-outbox-tenant','payout-outbox-merchant','SAR',
 '2026-11-01T00:00:00Z','2026-11-15T00:00:00Z');
INSERT INTO merchant_settlement_lines
(id,tenant_id,batch_id,merchant_id,currency,order_id,suborder_id,branch_id,
 contract_reference,gross_minor,deductions_minor,net_minor,deduction_breakdown)
VALUES ('payout-outbox-line','payout-outbox-tenant','payout-outbox-batch','payout-outbox-merchant','SAR',
 'payout-outbox-order','payout-outbox-suborder','payout-outbox-branch','payout-outbox-contract',5000,0,5000,'[]'::jsonb);
UPDATE merchant_settlement_batches
SET journal_id='payout-outbox-settlement-journal',status='approved'
WHERE tenant_id='payout-outbox-tenant' AND id='payout-outbox-batch';

INSERT INTO merchant_payout_intents
(id,tenant_id,merchant_id,currency,settlement_batch_id,amount_minor,idempotency_key,requested_by,requester_role)
VALUES ('payout-outbox-intent','payout-outbox-tenant','payout-outbox-merchant','SAR',
 'payout-outbox-batch',5000,'payout-outbox-idem-1','payout-outbox-ops','operations');
INSERT INTO merchant_payout_decisions
(id,tenant_id,payout_intent_id,decision,actor_id,actor_role)
VALUES ('payout-outbox-decision','payout-outbox-tenant','payout-outbox-intent','authorize',
 'payout-outbox-finance','finance');

INSERT INTO merchant_payout_destinations
(id,tenant_id,merchant_id,provider_key,currency,vault_reference,verification_status)
VALUES ('payout-outbox-destination','payout-outbox-tenant','payout-outbox-merchant',
 'sandbox-provider','SAR','vault://tenant/merchant/payout','pending');
UPDATE merchant_payout_destinations
SET verification_status='verified',verified_by='payout-outbox-finance',verified_at=now()
WHERE tenant_id='payout-outbox-tenant' AND id='payout-outbox-destination';

DO $checks$
DECLARE queued_id text;
DECLARE duplicate_id text;
BEGIN
  IF to_regclass('public.merchant_payout_provider_events') IS NULL THEN
    RAISE EXCEPTION 'merchant payout provider events table missing';
  END IF;
  IF to_regprocedure('public.enqueue_merchant_payout_provider_submission(text,text,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'payout provider enqueue function missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.oid='public.enqueue_merchant_payout_provider_submission(text,text,text,text,text,text,text)'::regprocedure
      AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
  ) THEN RAISE EXCEPTION 'payout enqueue function must not be executable by PUBLIC'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='merchant_payout_destinations'
      AND column_name IN ('iban','account_number','bank_account_number','raw_credentials')
  ) THEN RAISE EXCEPTION 'raw payout destination data column must not exist'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.merchant_payout_provider_outbox'::regclass
      AND tgname='merchant_payout_provider_outbox_guard' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'payout outbox immutable transition guard missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='merchant_payout_provider_outbox'
      AND indexname='merchant_payout_provider_outbox_due_idx'
  ) THEN RAISE EXCEPTION 'payout outbox due index missing'; END IF;

  queued_id := enqueue_merchant_payout_provider_submission(
    'payout-outbox-row','payout-outbox-tenant','payout-outbox-intent',
    'payout-outbox-destination','sandbox-provider','payout-provider-idem-1','payout-outbox-finance'
  );
  IF NOT EXISTS (
    SELECT 1 FROM merchant_payout_provider_outbox
    WHERE id=queued_id AND status='queued' AND amount_minor=5000
      AND currency='SAR' AND idempotency_key='payout-provider-idem-1'
  ) THEN RAISE EXCEPTION 'payout outbox did not copy exact authorized amount'; END IF;

  duplicate_id := enqueue_merchant_payout_provider_submission(
    'payout-outbox-row-duplicate','payout-outbox-tenant','payout-outbox-intent',
    'payout-outbox-destination','sandbox-provider','payout-provider-idem-1','payout-outbox-finance'
  );
  IF duplicate_id<>queued_id THEN RAISE EXCEPTION 'duplicate enqueue did not return original outbox id'; END IF;

  BEGIN
    PERFORM enqueue_merchant_payout_provider_submission(
      'payout-outbox-row-collision','payout-outbox-tenant','payout-outbox-intent',
      'payout-outbox-destination','sandbox-provider','payout-provider-idem-different','payout-outbox-finance'
    );
    RAISE EXCEPTION 'idempotency collision unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  IF (SELECT count(*) FROM merchant_payout_provider_outbox
      WHERE tenant_id='payout-outbox-tenant' AND payout_intent_id='payout-outbox-intent')<>1 THEN
    RAISE EXCEPTION 'more than one payout outbox row exists for one payout intent';
  END IF;
END
$checks$;

ROLLBACK;
