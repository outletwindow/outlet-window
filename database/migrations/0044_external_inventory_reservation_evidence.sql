-- Persist proof that a verified external POS/ERP hard reservation was mirrored
-- into the platform reservation ledger before an order can be confirmed.
CREATE TABLE IF NOT EXISTS inventory_provider_reservation_evidence (
  tenant_id text NOT NULL,
  reservation_id text NOT NULL,
  integration_id text NOT NULL,
  provider_key text NOT NULL CHECK (length(trim(provider_key)) BETWEEN 1 AND 100),
  provider_reservation_reference text NOT NULL
    CHECK (length(trim(provider_reservation_reference)) BETWEEN 1 AND 240),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, reservation_id),
  FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES inventory_reservations (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, integration_id)
    REFERENCES tenant_integrations (tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, integration_id, provider_reservation_reference),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS inventory_provider_reservation_evidence_expiry_idx
  ON inventory_provider_reservation_evidence (expires_at, tenant_id, reservation_id);

CREATE OR REPLACE FUNCTION validate_inventory_provider_reservation_evidence()
RETURNS trigger LANGUAGE plpgsql AS $
DECLARE
  reservation_expiry timestamptz;
  integration_provider_key text;
BEGIN
  SELECT r.expires_at INTO reservation_expiry
  FROM inventory_reservations r
  WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.reservation_id;
  IF NOT FOUND OR reservation_expiry IS DISTINCT FROM NEW.expires_at THEN
    RAISE EXCEPTION 'inventory_provider_reservation_expiry_mismatch'
      USING ERRCODE='55000';
  END IF;

  SELECT i.provider_key INTO integration_provider_key
  FROM tenant_integrations i
  JOIN merchant_inventory_provider_branch_scopes s
    ON s.tenant_id=i.tenant_id AND s.integration_id=i.id
  JOIN inventory_reservations r
    ON r.tenant_id=s.tenant_id AND r.id=NEW.reservation_id
   AND r.merchant_id=s.merchant_id AND r.branch_id=s.branch_id
  JOIN merchants m ON m.tenant_id=i.tenant_id AND m.id=s.merchant_id
  JOIN merchant_branches b ON b.merchant_id=s.merchant_id AND b.id=s.branch_id
  WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.integration_id
    AND i.family IN ('pos','erp') AND i.status='connected'
    AND i.capabilities @> '["inventory.hard_reservation"]'::jsonb
    AND s.active=true AND m.status='active' AND b.status='active';
  IF NOT FOUND OR integration_provider_key IS DISTINCT FROM NEW.provider_key THEN
    RAISE EXCEPTION 'inventory_provider_reservation_integration_scope_mismatch'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $;

CREATE TRIGGER inventory_provider_reservation_evidence_validate
BEFORE INSERT ON inventory_provider_reservation_evidence
FOR EACH ROW EXECUTE FUNCTION validate_inventory_provider_reservation_evidence();

CREATE OR REPLACE FUNCTION protect_inventory_provider_reservation_evidence()
RETURNS trigger LANGUAGE plpgsql AS $
BEGIN
  RAISE EXCEPTION 'inventory_provider_reservation_evidence_is_immutable'
    USING ERRCODE='55000';
END $$;

CREATE TRIGGER inventory_provider_reservation_evidence_immutable
BEFORE UPDATE OR DELETE ON inventory_provider_reservation_evidence
FOR EACH ROW EXECUTE FUNCTION protect_inventory_provider_reservation_evidence();

CREATE OR REPLACE FUNCTION reject_inventory_provider_reservation_evidence_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_provider_reservation_evidence_cannot_be_truncated'
    USING ERRCODE='55000';
END $$;

CREATE TRIGGER inventory_provider_reservation_evidence_no_truncate
BEFORE TRUNCATE ON inventory_provider_reservation_evidence
FOR EACH STATEMENT EXECUTE FUNCTION reject_inventory_provider_reservation_evidence_truncate();
