-- Immutable mapping from Moyasar's platform merchant/entity identifiers to a local merchant.
-- These identifiers are not secrets; no bank or beneficiary data is stored here.
CREATE TABLE merchant_payout_provider_entities (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  merchant_id text NOT NULL,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-zA-Z0-9._-]{1,100}$'),
  provider_merchant_id text NOT NULL CHECK (length(trim(provider_merchant_id)) BETWEEN 1 AND 240),
  provider_entity_id text NOT NULL CHECK (length(trim(provider_entity_id)) BETWEEN 1 AND 240),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by text NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id,merchant_id) REFERENCES merchants(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,id),
  CHECK ((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX merchant_payout_provider_entities_active_merchant_idx
  ON merchant_payout_provider_entities(tenant_id,merchant_id,provider_key)
  WHERE status='active';
CREATE UNIQUE INDEX merchant_payout_provider_entities_active_provider_identity_idx
  ON merchant_payout_provider_entities(provider_key,provider_merchant_id,provider_entity_id)
  WHERE status='active';

CREATE OR REPLACE FUNCTION guard_merchant_payout_provider_entity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'merchant_payout_provider_entity_is_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
     OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.provider_merchant_id IS DISTINCT FROM OLD.provider_merchant_id
     OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.status<>'active' OR NEW.status<>'revoked'
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'merchant_payout_provider_entity_identity_is_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER merchant_payout_provider_entity_guard
BEFORE UPDATE OR DELETE ON merchant_payout_provider_entities
FOR EACH ROW EXECUTE FUNCTION guard_merchant_payout_provider_entity();
