-- Durable provider handoff for independently authorized merchant payouts.
-- Only opaque vault references are stored; no IBAN, account number, or bank credential.
CREATE TABLE merchant_payout_destinations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  merchant_id text NOT NULL,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-zA-Z0-9._-]{1,100}$'),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  vault_reference text NOT NULL CHECK (length(trim(vault_reference)) BETWEEN 8 AND 500),
  verification_status text NOT NULL CHECK (verification_status IN ('pending','verified','revoked')),
  verified_by text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,merchant_id) REFERENCES merchants(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,merchant_id,id),
  CHECK ((verification_status='verified' AND verified_by IS NOT NULL AND verified_at IS NOT NULL)
      OR verification_status<>'verified')
);
CREATE INDEX merchant_payout_destinations_verified_idx
  ON merchant_payout_destinations(tenant_id,merchant_id,provider_key,currency)
  WHERE verification_status='verified';

CREATE TABLE merchant_payout_provider_outbox (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  payout_intent_id text NOT NULL,
  merchant_id text NOT NULL,
  destination_id text NOT NULL,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-zA-Z0-9._-]{1,100}$'),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9000000000000000),
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 240),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','submitted','confirmed','failed','reconciliation_required')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  provider_reference text,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_.:-]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  confirmed_at timestamptz,
  FOREIGN KEY (tenant_id,payout_intent_id) REFERENCES merchant_payout_intents(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,merchant_id,destination_id)
    REFERENCES merchant_payout_destinations(tenant_id,merchant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,payout_intent_id),
  UNIQUE (tenant_id,provider_key,idempotency_key),
  CHECK ((status='processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status<>'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)),
  CHECK ((status IN ('submitted','confirmed') AND provider_reference IS NOT NULL)
      OR status NOT IN ('submitted','confirmed')),
  CHECK ((status='submitted' AND submitted_at IS NOT NULL AND confirmed_at IS NULL)
      OR (status='confirmed' AND submitted_at IS NOT NULL AND confirmed_at IS NOT NULL)
      OR (status NOT IN ('submitted','confirmed') AND submitted_at IS NULL AND confirmed_at IS NULL)),
  CHECK (provider_reference IS NULL OR length(trim(provider_reference)) BETWEEN 1 AND 240)
);
CREATE INDEX merchant_payout_provider_outbox_due_idx
  ON merchant_payout_provider_outbox(available_at,created_at)
  WHERE status='queued';
CREATE INDEX merchant_payout_provider_outbox_lease_idx
  ON merchant_payout_provider_outbox(lease_expires_at)
  WHERE status='processing';

CREATE TABLE merchant_payout_provider_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  outbox_id text NOT NULL,
  provider_key text NOT NULL,
  provider_event_id text NOT NULL CHECK (length(trim(provider_event_id)) BETWEEN 1 AND 240),
  provider_reference text NOT NULL CHECK (length(trim(provider_reference)) BETWEEN 1 AND 240),
  event_type text NOT NULL CHECK (event_type IN ('payout_submitted','payout_confirmed','payout_failed')),
  signature_verified boolean NOT NULL DEFAULT false,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,provider_key,provider_event_id),
  FOREIGN KEY (tenant_id,outbox_id) REFERENCES merchant_payout_provider_outbox(tenant_id,id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION enqueue_merchant_payout_provider_submission(
  p_id text, p_tenant_id text, p_payout_intent_id text, p_destination_id text,
  p_provider_key text, p_idempotency_key text, p_actor_id text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE intent_row merchant_payout_intents%ROWTYPE;
DECLARE destination_row merchant_payout_destinations%ROWTYPE;
DECLARE outbox_id text;
BEGIN
  SELECT * INTO intent_row FROM merchant_payout_intents
   WHERE tenant_id=p_tenant_id AND id=p_payout_intent_id FOR UPDATE;
  IF NOT FOUND OR intent_row.status<>'authorized' THEN
    RAISE EXCEPTION 'payout_intent_not_authorized' USING ERRCODE='23514';
  END IF;
  SELECT * INTO destination_row FROM merchant_payout_destinations
   WHERE tenant_id=p_tenant_id AND id=p_destination_id
     AND merchant_id=intent_row.merchant_id AND provider_key=p_provider_key
     AND currency=intent_row.currency AND verification_status='verified'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verified_payout_destination_required' USING ERRCODE='23514';
  END IF;
  INSERT INTO merchant_payout_provider_outbox
    (id,tenant_id,payout_intent_id,merchant_id,destination_id,provider_key,currency,
     amount_minor,idempotency_key)
  VALUES (p_id,p_tenant_id,p_payout_intent_id,intent_row.merchant_id,p_destination_id,
    p_provider_key,intent_row.currency,intent_row.amount_minor,p_idempotency_key)
  ON CONFLICT (tenant_id,payout_intent_id) DO NOTHING
  RETURNING id INTO outbox_id;
  IF outbox_id IS NULL THEN
    SELECT id INTO outbox_id FROM merchant_payout_provider_outbox
     WHERE tenant_id=p_tenant_id AND payout_intent_id=p_payout_intent_id
       AND destination_id=p_destination_id AND provider_key=p_provider_key
       AND idempotency_key=p_idempotency_key;
    IF outbox_id IS NULL THEN
      RAISE EXCEPTION 'payout_outbox_idempotency_conflict' USING ERRCODE='23505';
    END IF;
  END IF;
  IF outbox_id IS NULL THEN RAISE EXCEPTION 'payout_outbox_enqueue_failed'; END IF;
  INSERT INTO audit_events (
    id,schema_version,event_type,category,occurred_at,actor_id,actor_type,actor_role,
    action,outcome,resource_type,resource_id,tenant_id,merchant_id,correlation_id,
    source,severity,metadata
  ) VALUES (
    'merchant-payout-outbox:'||p_tenant_id||':'||outbox_id,1,
    'merchant_payout_provider_submission_queued','finance',now(),p_actor_id,
    'platform_user','finance','enqueue_merchant_payout_provider_submission','pending',
    'merchant_payout_provider_outbox',outbox_id,p_tenant_id,intent_row.merchant_id,
    outbox_id,'merchant_payout_provider_outbox','high',
    jsonb_build_object('payoutIntentId',p_payout_intent_id,'providerKey',p_provider_key,
      'amountMinor',intent_row.amount_minor,'currency',intent_row.currency)
  ) ON CONFLICT (id) DO NOTHING;
  RETURN outbox_id;
END $$;
REVOKE ALL ON FUNCTION enqueue_merchant_payout_provider_submission(text,text,text,text,text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION guard_merchant_payout_outbox()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'merchant_payout_outbox_is_immutable' USING ERRCODE='55000'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.payout_intent_id IS DISTINCT FROM OLD.payout_intent_id
    OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
    OR NEW.destination_id IS DISTINCT FROM OLD.destination_id
    OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'merchant_payout_outbox_identity_is_immutable' USING ERRCODE='55000';
  END IF;
  IF NOT (
    (OLD.status='queued' AND NEW.status IN ('processing','failed','reconciliation_required')) OR
    (OLD.status='processing' AND NEW.status IN ('queued','submitted','failed','reconciliation_required')) OR
    (OLD.status='submitted' AND NEW.status IN ('confirmed','reconciliation_required')) OR
    (OLD.status=NEW.status AND OLD.status IN ('queued','processing'))
  ) THEN RAISE EXCEPTION 'merchant_payout_outbox_transition_invalid' USING ERRCODE='55000'; END IF;
  IF NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count+1 THEN
    RAISE EXCEPTION 'merchant_payout_outbox_attempt_count_invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER merchant_payout_provider_outbox_guard
BEFORE UPDATE OR DELETE ON merchant_payout_provider_outbox
FOR EACH ROW EXECUTE FUNCTION guard_merchant_payout_outbox();

CREATE OR REPLACE FUNCTION guard_merchant_payout_destination()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'merchant_payout_destination_history_is_immutable' USING ERRCODE='55000'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
    OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.vault_reference IS DISTINCT FROM OLD.vault_reference
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'merchant_payout_destination_identity_is_immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.verification_status='revoked' OR NEW.verification_status NOT IN ('verified','revoked') THEN
    RAISE EXCEPTION 'merchant_payout_destination_transition_invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER merchant_payout_destination_guard
BEFORE UPDATE OR DELETE ON merchant_payout_destinations
FOR EACH ROW EXECUTE FUNCTION guard_merchant_payout_destination();

CREATE OR REPLACE FUNCTION prevent_merchant_payout_provider_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'merchant_payout_provider_events_are_append_only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER merchant_payout_provider_events_immutable
BEFORE UPDATE OR DELETE ON merchant_payout_provider_events
FOR EACH ROW EXECUTE FUNCTION prevent_merchant_payout_provider_history_mutation();
