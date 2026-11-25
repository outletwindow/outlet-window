-- Atomic accounting posting for an independently authorized merchant settlement.
-- This function posts ledger reclassification only. It never initiates a payout.
CREATE OR REPLACE FUNCTION post_merchant_settlement_accounting(
  p_tenant_id text,
  p_batch_id text,
  p_actor_id text,
  p_actor_role text
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  batch_row merchant_settlement_batches%ROWTYPE;
  approval_row merchant_settlement_approval_requests%ROWTYPE;
  policy_row merchant_settlement_policy_snapshots%ROWTYPE;
  line_count bigint;
  gross_total numeric;
  deductions_total numeric;
  net_total numeric;
  missing_mapping_count bigint;
  held_account_id text;
  payable_account_id text;
  journal_id_value text;
  journal_key text;
  next_line_number integer := 1;
  mapping_row record;
BEGIN
  IF p_tenant_id IS NULL OR length(trim(p_tenant_id))=0
     OR p_batch_id IS NULL OR length(trim(p_batch_id))=0
     OR p_actor_id IS NULL OR length(trim(p_actor_id))=0
     OR p_actor_role IS NULL
     OR p_actor_role NOT IN ('finance','platform_admin','platform_owner') THEN
    RAISE EXCEPTION 'settlement_accounting_actor_not_authorized'
      USING ERRCODE='42501';
  END IF;

  SELECT * INTO batch_row
  FROM merchant_settlement_batches
  WHERE tenant_id=p_tenant_id AND id=p_batch_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_batch_not_found' USING ERRCODE='P0002';
  END IF;

  SELECT * INTO approval_row
  FROM merchant_settlement_approval_requests
  WHERE tenant_id=p_tenant_id AND batch_id=p_batch_id
    AND status='authorized_for_accounting'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_accounting_authorization_required'
      USING ERRCODE='42501';
  END IF;
  IF approval_row.requested_by=p_actor_id THEN
    RAISE EXCEPTION 'settlement_requester_cannot_post_own_batch'
      USING ERRCODE='42501';
  END IF;

  IF batch_row.status='approved' THEN
    RETURN batch_row.journal_id;
  END IF;
  IF batch_row.status <> 'draft' THEN
    RAISE EXCEPTION 'settlement_batch_not_postable' USING ERRCODE='23514';
  END IF;

  IF batch_row.policy_snapshot_id IS NULL THEN
    RAISE EXCEPTION 'settlement_policy_snapshot_required'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO policy_row
  FROM merchant_settlement_policy_snapshots
  WHERE tenant_id=p_tenant_id AND id=batch_row.policy_snapshot_id
    AND merchant_id=batch_row.merchant_id AND currency=batch_row.currency
  FOR SHARE;
  IF NOT FOUND OR policy_row.approved_by IS NULL OR policy_row.approved_at IS NULL THEN
    RAISE EXCEPTION 'settlement_policy_snapshot_not_approved'
      USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*),COALESCE(SUM(gross_minor),0),
         COALESCE(SUM(deductions_minor),0),COALESCE(SUM(net_minor),0)
  INTO line_count,gross_total,deductions_total,net_total
  FROM merchant_settlement_lines
  WHERE tenant_id=p_tenant_id AND batch_id=p_batch_id;
  IF line_count=0 OR gross_total<>deductions_total+net_total THEN
    RAISE EXCEPTION 'settlement_batch_totals_invalid' USING ERRCODE='23514';
  END IF;
  IF line_count<>approval_row.snapshot_line_count
     OR gross_total<>approval_row.snapshot_gross_minor
     OR deductions_total<>approval_row.snapshot_deductions_minor
     OR net_total<>approval_row.snapshot_net_minor THEN
    RAISE EXCEPTION 'settlement_approval_snapshot_changed' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM merchant_settlement_lines
    WHERE tenant_id=p_tenant_id AND batch_id=p_batch_id
      AND contract_reference<>policy_row.contract_reference
  ) THEN
    RAISE EXCEPTION 'settlement_line_contract_policy_mismatch' USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*) INTO missing_mapping_count
  FROM merchant_settlement_lines line
  CROSS JOIN LATERAL jsonb_array_elements(line.deduction_breakdown) item
  LEFT JOIN merchant_settlement_deduction_account_mappings mapping
    ON mapping.tenant_id=line.tenant_id
   AND mapping.policy_snapshot_id=batch_row.policy_snapshot_id
   AND mapping.deduction_code=item->>'code'
   AND mapping.currency=batch_row.currency
  LEFT JOIN financial_accounts account
    ON account.tenant_id=mapping.tenant_id
   AND account.id=mapping.account_id
   AND account.currency=mapping.currency
   AND account.is_active
  WHERE line.tenant_id=p_tenant_id AND line.batch_id=p_batch_id
    AND (mapping.id IS NULL OR account.id IS NULL);
  IF missing_mapping_count<>0 THEN
    RAISE EXCEPTION 'settlement_deduction_account_mapping_missing_or_inactive'
      USING ERRCODE='23514';
  END IF;

  SELECT id INTO held_account_id
  FROM financial_accounts
  WHERE tenant_id=p_tenant_id AND currency=batch_row.currency
    AND account_code='CUSTOMER_FUNDS_HELD'
    AND account_type='liability' AND is_active
  FOR SHARE;
  SELECT id INTO payable_account_id
  FROM financial_accounts
  WHERE tenant_id=p_tenant_id AND currency=batch_row.currency
    AND account_code='MERCHANT_PAYABLE'
    AND account_type='liability' AND is_active
  FOR SHARE;
  IF held_account_id IS NULL OR payable_account_id IS NULL THEN
    RAISE EXCEPTION 'settlement_required_control_accounts_missing'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM merchant_settlement_deduction_account_mappings mapping
    WHERE mapping.tenant_id=p_tenant_id
      AND mapping.policy_snapshot_id=batch_row.policy_snapshot_id
      AND mapping.currency=batch_row.currency
      AND mapping.account_id IN (held_account_id,payable_account_id)
      AND EXISTS (
        SELECT 1
        FROM merchant_settlement_lines line
        CROSS JOIN LATERAL jsonb_array_elements(line.deduction_breakdown) item
        WHERE line.tenant_id=p_tenant_id AND line.batch_id=p_batch_id
          AND item->>'code'=mapping.deduction_code
      )
  ) THEN
    RAISE EXCEPTION 'settlement_deduction_mapping_conflicts_with_control_account'
      USING ERRCODE='23514';
  END IF;

  journal_key := 'merchant-settlement:' || p_tenant_id || ':' || p_batch_id;
  journal_id_value := 'settlement-journal-' || md5(p_tenant_id || ':' || p_batch_id);

  IF EXISTS (
    SELECT 1 FROM financial_journals
    WHERE tenant_id=p_tenant_id AND idempotency_key=journal_key
  ) THEN
    RAISE EXCEPTION 'settlement_journal_idempotency_collision'
      USING ERRCODE='23505';
  END IF;

  INSERT INTO financial_journals
    (id,tenant_id,idempotency_key,source_type,source_reference,currency,
     description,status,occurred_at)
  VALUES
    (journal_id_value,p_tenant_id,journal_key,'merchant_settlement',p_batch_id,
     batch_row.currency,'Merchant settlement accounting posting','draft',clock_timestamp());

  INSERT INTO financial_journal_lines
    (id,tenant_id,journal_id,account_id,currency,line_number,debit_minor,credit_minor,memo)
  VALUES
    (gen_random_uuid()::text,p_tenant_id,journal_id_value,held_account_id,
     batch_row.currency,next_line_number,gross_total,0,'Customer funds released to merchant settlement');
  next_line_number := next_line_number+1;

  INSERT INTO financial_journal_lines
    (id,tenant_id,journal_id,account_id,currency,line_number,debit_minor,credit_minor,memo)
  VALUES
    (gen_random_uuid()::text,p_tenant_id,journal_id_value,payable_account_id,
     batch_row.currency,next_line_number,0,net_total,'Net merchant payable');
  next_line_number := next_line_number+1;

  FOR mapping_row IN
    SELECT mapping.account_id,SUM((item->>'amountMinor')::bigint) AS amount_minor,
           mapping.deduction_code
    FROM merchant_settlement_lines line
    CROSS JOIN LATERAL jsonb_array_elements(line.deduction_breakdown) item
    JOIN merchant_settlement_deduction_account_mappings mapping
      ON mapping.tenant_id=line.tenant_id
     AND mapping.policy_snapshot_id=batch_row.policy_snapshot_id
     AND mapping.deduction_code=item->>'code'
     AND mapping.currency=batch_row.currency
    WHERE line.tenant_id=p_tenant_id AND line.batch_id=p_batch_id
    GROUP BY mapping.account_id,mapping.deduction_code
    ORDER BY mapping.account_id,mapping.deduction_code
  LOOP
    INSERT INTO financial_journal_lines
      (id,tenant_id,journal_id,account_id,currency,line_number,debit_minor,credit_minor,memo)
    VALUES
      (gen_random_uuid()::text,p_tenant_id,journal_id_value,mapping_row.account_id,
       batch_row.currency,next_line_number,0,mapping_row.amount_minor,
       'Settlement deduction: ' || mapping_row.deduction_code);
    next_line_number := next_line_number+1;
  END LOOP;

  UPDATE financial_journals SET status='posted'
  WHERE tenant_id=p_tenant_id AND id=journal_id_value AND status='draft';

  UPDATE merchant_settlement_batches
  SET journal_id=journal_id_value,status='approved'
  WHERE tenant_id=p_tenant_id AND id=p_batch_id AND status='draft';

  INSERT INTO audit_events (
    id,schema_version,event_type,category,occurred_at,actor_id,actor_type,actor_role,
    action,outcome,resource_type,resource_id,tenant_id,merchant_id,
    correlation_id,source,severity,approval_id,metadata
  ) VALUES (
    'settlement-accounting-posted:' || p_tenant_id || ':' || p_batch_id,
    1,'merchant_settlement_accounting_posted','finance',clock_timestamp(),
    p_actor_id,'platform_user',p_actor_role,'post_merchant_settlement_accounting',
    'success','merchant_settlement_batch',p_batch_id,p_tenant_id,batch_row.merchant_id,
    'merchant-settlement-posting:' || p_batch_id,'merchant_settlement_accounting','high',
    approval_row.id,jsonb_build_object('journalId',journal_id_value,
      'policySnapshotId',policy_row.id,'policyVersion',policy_row.policy_version,
      'policySha256',policy_row.policy_sha256,'currency',batch_row.currency,
      'lineCount',line_count,'grossMinor',gross_total,
      'deductionsMinor',deductions_total,'netMinor',net_total)
  );

  RETURN journal_id_value;
END
$$;

-- Do not expose the posting primitive to arbitrary database roles.
REVOKE ALL ON FUNCTION post_merchant_settlement_accounting(text,text,text,text) FROM PUBLIC;
