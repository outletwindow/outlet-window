-- Reconcile a cryptographically verified provider confirmation to a payout journal.
-- Provider acceptance alone remains "submitted"; this function requires a signed confirmation.
CREATE TABLE merchant_payout_account_mappings (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  merchant_payable_account_id text NOT NULL,
  payout_clearing_account_id text NOT NULL,
  approved_by text NOT NULL CHECK (length(trim(approved_by)) BETWEEN 1 AND 160),
  approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,merchant_payable_account_id,currency)
    REFERENCES financial_accounts(tenant_id,id,currency) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,payout_clearing_account_id,currency)
    REFERENCES financial_accounts(tenant_id,id,currency) ON DELETE RESTRICT,
  UNIQUE (tenant_id,currency),
  CHECK (merchant_payable_account_id <> payout_clearing_account_id)
);

CREATE OR REPLACE FUNCTION guard_merchant_payout_account_mapping()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'merchant_payout_account_mapping_is_immutable'
    USING ERRCODE='55000';
END $$;
CREATE TRIGGER merchant_payout_account_mapping_immutable
BEFORE UPDATE OR DELETE ON merchant_payout_account_mappings
FOR EACH ROW EXECUTE FUNCTION guard_merchant_payout_account_mapping();

CREATE OR REPLACE FUNCTION post_confirmed_merchant_payout(
  p_event_row_id text,
  p_tenant_id text,
  p_outbox_id text,
  p_provider_key text,
  p_provider_event_id text,
  p_provider_reference text,
  p_amount_minor bigint,
  p_currency text,
  p_actor_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  payout_row merchant_payout_provider_outbox%ROWTYPE;
  mapping_row merchant_payout_account_mappings%ROWTYPE;
  existing_event merchant_payout_provider_events%ROWTYPE;
  journal_id_value text;
  journal_key text;
BEGIN
  IF p_event_row_id IS NULL OR length(trim(p_event_row_id))=0
     OR p_tenant_id IS NULL OR length(trim(p_tenant_id))=0
     OR p_outbox_id IS NULL OR length(trim(p_outbox_id))=0
     OR p_actor_id IS NULL OR length(trim(p_actor_id))=0
     OR p_provider_key IS NULL OR length(trim(p_provider_key))=0
     OR p_provider_event_id IS NULL OR length(trim(p_provider_event_id)) NOT BETWEEN 1 AND 240
     OR p_provider_reference IS NULL OR length(trim(p_provider_reference)) NOT BETWEEN 1 AND 240
     OR p_amount_minor IS NULL OR p_amount_minor <= 0
     OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'merchant_payout_confirmation_input_invalid' USING ERRCODE='22023';
  END IF;

  SELECT * INTO payout_row
  FROM merchant_payout_provider_outbox
  WHERE tenant_id=p_tenant_id AND id=p_outbox_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merchant_payout_outbox_not_found' USING ERRCODE='P0002';
  END IF;

  SELECT * INTO existing_event
  FROM merchant_payout_provider_events
  WHERE tenant_id=p_tenant_id AND provider_key=p_provider_key
    AND provider_event_id=p_provider_event_id;
  IF FOUND THEN
    IF existing_event.outbox_id<>p_outbox_id
       OR existing_event.provider_reference<>p_provider_reference
       OR existing_event.amount_minor<>p_amount_minor
       OR existing_event.currency<>p_currency
       OR existing_event.event_type<>'payout_confirmed'
       OR NOT existing_event.signature_verified THEN
      RAISE EXCEPTION 'merchant_payout_provider_event_id_collision' USING ERRCODE='23505';
    END IF;
    SELECT id INTO journal_id_value
    FROM financial_journals
    WHERE tenant_id=p_tenant_id
      AND idempotency_key='merchant-payout:'||p_tenant_id||':'||p_outbox_id;
    IF journal_id_value IS NULL THEN
      RAISE EXCEPTION 'merchant_payout_confirmation_journal_missing' USING ERRCODE='23514';
    END IF;
    RETURN journal_id_value;
  END IF;

  IF payout_row.status<>'submitted'
     OR payout_row.provider_key<>p_provider_key
     OR payout_row.provider_reference<>p_provider_reference
     OR payout_row.amount_minor<>p_amount_minor
     OR payout_row.currency<>p_currency THEN
    RAISE EXCEPTION 'merchant_payout_confirmation_mismatch' USING ERRCODE='23514';
  END IF;

  SELECT * INTO mapping_row
  FROM merchant_payout_account_mappings
  WHERE tenant_id=p_tenant_id AND currency=p_currency
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merchant_payout_account_mapping_required' USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM financial_accounts
    WHERE tenant_id=p_tenant_id AND id=mapping_row.merchant_payable_account_id
      AND currency=p_currency AND account_code='MERCHANT_PAYABLE'
      AND account_type='liability' AND is_active
  ) OR NOT EXISTS (
    SELECT 1 FROM financial_accounts
    WHERE tenant_id=p_tenant_id AND id=mapping_row.payout_clearing_account_id
      AND currency=p_currency AND account_code='PAYOUT_CLEARING'
      AND account_type='asset' AND is_active
  ) THEN
    RAISE EXCEPTION 'merchant_payout_control_accounts_invalid' USING ERRCODE='23514';
  END IF;

  INSERT INTO merchant_payout_provider_events
    (id,tenant_id,outbox_id,provider_key,provider_event_id,provider_reference,
     event_type,signature_verified,amount_minor,currency)
  VALUES
    (p_event_row_id,p_tenant_id,p_outbox_id,p_provider_key,p_provider_event_id,
     p_provider_reference,'payout_confirmed',true,p_amount_minor,p_currency);

  journal_key := 'merchant-payout:'||p_tenant_id||':'||p_outbox_id;
  journal_id_value := 'payout-journal-'||md5(p_tenant_id||':'||p_outbox_id);
  INSERT INTO financial_journals
    (id,tenant_id,idempotency_key,source_type,source_reference,currency,
     description,status,occurred_at)
  VALUES
    (journal_id_value,p_tenant_id,journal_key,'merchant_payout',p_outbox_id,
     p_currency,'Confirmed merchant payout','draft',clock_timestamp());

  INSERT INTO financial_journal_lines
    (id,tenant_id,journal_id,account_id,currency,line_number,debit_minor,credit_minor,memo)
  VALUES
    (gen_random_uuid()::text,p_tenant_id,journal_id_value,
     mapping_row.merchant_payable_account_id,p_currency,1,p_amount_minor,0,
     'Settle merchant payable after verified provider confirmation'),
    (gen_random_uuid()::text,p_tenant_id,journal_id_value,
     mapping_row.payout_clearing_account_id,p_currency,2,0,p_amount_minor,
     'Provider payout clearing for confirmed disbursement');

  UPDATE financial_journals SET status='posted'
  WHERE tenant_id=p_tenant_id AND id=journal_id_value AND status='draft';

  UPDATE merchant_payout_provider_outbox
  SET status='confirmed',confirmed_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE tenant_id=p_tenant_id AND id=p_outbox_id AND status='submitted';

  INSERT INTO audit_events (
    id,schema_version,event_type,category,occurred_at,actor_id,actor_type,actor_role,
    action,outcome,resource_type,resource_id,tenant_id,merchant_id,
    correlation_id,source,severity,metadata
  ) VALUES (
    'merchant-payout-confirmed:'||p_tenant_id||':'||p_outbox_id,
    1,'merchant_payout_provider_confirmed','finance',clock_timestamp(),
    p_actor_id,'platform_user','finance','post_confirmed_merchant_payout',
    'success','merchant_payout_provider_outbox',p_outbox_id,p_tenant_id,
    payout_row.merchant_id,p_provider_event_id,'merchant_payout_reconciliation','high',
    jsonb_build_object('journalId',journal_id_value,'providerKey',p_provider_key,
      'providerReference',p_provider_reference,'amountMinor',p_amount_minor,
      'currency',p_currency,'providerEventId',p_provider_event_id)
  );
  RETURN journal_id_value;
END
$$;

REVOKE ALL ON FUNCTION post_confirmed_merchant_payout(text,text,text,text,text,text,bigint,text,text) FROM PUBLIC;
