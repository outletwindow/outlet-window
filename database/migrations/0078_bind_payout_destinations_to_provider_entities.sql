-- Bind every newly created/verified payout destination to the immutable
-- platform-side provider entity mapping for the same tenant and merchant.
-- Legacy rows without a mapping remain readable but cannot be newly verified
-- or claimed for payout until a replacement destination is registered.

ALTER TABLE merchant_payout_provider_entities
  ADD CONSTRAINT merchant_payout_provider_entities_destination_identity_key
  UNIQUE (tenant_id,merchant_id,provider_key,id);

ALTER TABLE merchant_payout_destinations
  ADD COLUMN provider_entity_registry_id text;

ALTER TABLE merchant_payout_destinations
  ADD CONSTRAINT merchant_payout_destination_provider_entity_fk
  FOREIGN KEY (tenant_id,merchant_id,provider_key,provider_entity_registry_id)
  REFERENCES merchant_payout_provider_entities(tenant_id,merchant_id,provider_key,id)
  ON DELETE RESTRICT;

CREATE INDEX merchant_payout_destination_provider_entity_idx
  ON merchant_payout_destinations(tenant_id,merchant_id,provider_key,provider_entity_registry_id);

CREATE OR REPLACE FUNCTION require_active_merchant_payout_provider_entity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verification_status <> 'revoked' THEN
    IF NEW.provider_entity_registry_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM merchant_payout_provider_entities e
      WHERE e.tenant_id=NEW.tenant_id
        AND e.merchant_id=NEW.merchant_id
        AND e.provider_key=NEW.provider_key
        AND e.id=NEW.provider_entity_registry_id
        AND e.status='active'
      FOR KEY SHARE
    ) THEN
      RAISE EXCEPTION 'active_payout_provider_entity_mapping_required'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER merchant_payout_destination_provider_entity_required
BEFORE INSERT OR UPDATE OF verification_status,provider_entity_registry_id
ON merchant_payout_destinations
FOR EACH ROW EXECUTE FUNCTION require_active_merchant_payout_provider_entity();

CREATE OR REPLACE FUNCTION guard_merchant_payout_destination()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'merchant_payout_destination_history_is_immutable';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
    OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.vault_reference IS DISTINCT FROM OLD.vault_reference
    OR NEW.provider_entity_registry_id IS DISTINCT FROM OLD.provider_entity_registry_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'merchant_payout_destination_identity_is_immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.verification_status='revoked'
    OR NEW.verification_status NOT IN ('verified','revoked') THEN
    RAISE EXCEPTION 'merchant_payout_destination_transition_invalid'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$$;

-- Last-line database guard: a verified destination is not sufficient by itself.
-- Its provider entity must still be active and bound to the same merchant.
CREATE OR REPLACE FUNCTION guard_merchant_payout_outbox_provider_entity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM merchant_payout_destinations d
    JOIN merchant_payout_provider_entities e
      ON e.tenant_id=d.tenant_id
     AND e.merchant_id=d.merchant_id
     AND e.provider_key=d.provider_key
     AND e.id=d.provider_entity_registry_id
     AND e.status='active'
    WHERE d.tenant_id=NEW.tenant_id
      AND d.merchant_id=NEW.merchant_id
      AND d.id=NEW.destination_id
      AND d.provider_key=NEW.provider_key
      AND d.currency=NEW.currency
      AND d.verification_status='verified'
  ) THEN
    RAISE EXCEPTION 'active_verified_provider_entity_destination_required'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER merchant_payout_outbox_provider_entity_required
BEFORE INSERT ON merchant_payout_provider_outbox
FOR EACH ROW EXECUTE FUNCTION guard_merchant_payout_outbox_provider_entity();
