\set ON_ERROR_STOP on
BEGIN;

INSERT INTO tenants (id,tenant_type,display_name,status)
VALUES ('ledger-tenant','platform','Ledger Test Tenant','active');

INSERT INTO financial_accounts
(id,tenant_id,account_code,account_name,account_type,currency)
VALUES
 ('ledger-cash','ledger-tenant','1000','Cash','asset','SAR'),
 ('ledger-payable','ledger-tenant','2100','Merchant payable','liability','SAR'),
 ('ledger-revenue','ledger-tenant','4000','Platform revenue','revenue','SAR'),
 ('ledger-usd','ledger-tenant','1000-USD','Cash USD','asset','USD');

INSERT INTO financial_journals
(id,tenant_id,idempotency_key,source_type,source_reference,currency,description,occurred_at)
VALUES ('ledger-balanced','ledger-tenant','ledger-balanced-key','payment_capture','capture-1',
        'SAR','Captured payment allocation',now()),
       ('ledger-unbalanced','ledger-tenant','ledger-unbalanced-key','payment_capture','capture-2',
        'SAR','Unbalanced capture',now()),
       ('ledger-single-line','ledger-tenant','ledger-single-line-key','adjustment','adjustment-1',
        'SAR','Single line journal',now());

INSERT INTO financial_journal_lines
(id,tenant_id,journal_id,account_id,currency,line_number,debit_minor,credit_minor)
VALUES ('ledger-line-1','ledger-tenant','ledger-balanced','ledger-cash','SAR',1,10000,0),
       ('ledger-line-2','ledger-tenant','ledger-balanced','ledger-payable','SAR',2,0,9000),
       ('ledger-line-3','ledger-tenant','ledger-balanced','ledger-revenue','SAR',3,0,1000),
       ('ledger-line-4','ledger-tenant','ledger-unbalanced','ledger-cash','SAR',1,10000,0),
       ('ledger-line-5','ledger-tenant','ledger-unbalanced','ledger-revenue','SAR',2,0,900),
       ('ledger-line-6','ledger-tenant','ledger-single-line','ledger-cash','SAR',1,10000,0);

DO $$
BEGIN
  UPDATE financial_journals SET status='posted' WHERE id='ledger-balanced';
  IF (SELECT posted_at IS NULL FROM financial_journals WHERE id='ledger-balanced') THEN
    RAISE EXCEPTION 'balanced journal did not receive posted_at';
  END IF;

  BEGIN
    UPDATE financial_journals SET status='posted' WHERE id='ledger-unbalanced';
    RAISE EXCEPTION 'unbalanced journal unexpectedly posted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE financial_journals SET status='posted' WHERE id='ledger-single-line';
    RAISE EXCEPTION 'single-line journal unexpectedly posted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE financial_journal_lines SET debit_minor=9999 WHERE id='ledger-line-1';
    RAISE EXCEPTION 'posted journal line unexpectedly updated';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    DELETE FROM financial_journal_lines WHERE id='ledger-line-1';
    RAISE EXCEPTION 'posted journal line unexpectedly deleted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE financial_journals SET description='changed' WHERE id='ledger-balanced';
    RAISE EXCEPTION 'posted journal header unexpectedly updated';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    INSERT INTO financial_journal_lines
    (id,tenant_id,journal_id,account_id,currency,line_number,debit_minor,credit_minor)
    VALUES ('ledger-late-line','ledger-tenant','ledger-balanced','ledger-cash','SAR',4,1,0);
    RAISE EXCEPTION 'posted journal unexpectedly accepted a new line';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE financial_journal_lines SET journal_id='ledger-unbalanced' WHERE id='ledger-line-1';
    RAISE EXCEPTION 'posted journal line unexpectedly moved to another journal';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    INSERT INTO financial_journal_lines
    (id,tenant_id,journal_id,account_id,currency,line_number,debit_minor,credit_minor)
    VALUES ('ledger-cross-currency','ledger-tenant','ledger-unbalanced','ledger-usd','USD',3,1,0);
    RAISE EXCEPTION 'cross-currency journal line unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO financial_journals
    (id,tenant_id,idempotency_key,source_type,source_reference,currency,description,occurred_at)
    VALUES ('ledger-duplicate','ledger-tenant','ledger-balanced-key','payment_capture','capture-3',
            'SAR','Duplicate idempotency key',now());
    RAISE EXCEPTION 'duplicate journal idempotency key unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

ROLLBACK;
