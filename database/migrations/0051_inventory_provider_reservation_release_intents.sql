-- Persist the first release intent timestamp independently from immutable provider receipt evidence.
-- Every retry for one external reservation must send the exact same provider payload.
CREATE TABLE inventory_provider_reservation_release_intents (
  tenant_id text NOT NULL,
  reservation_id text NOT NULL,
  integration_id text NOT NULL,
  released_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, reservation_id),
  FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES inventory_provider_reservation_evidence (tenant_id, reservation_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, integration_id)
    REFERENCES tenant_integrations (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX inventory_provider_reservation_release_intents_created_idx
  ON inventory_provider_reservation_release_intents (created_at, tenant_id, reservation_id);

CREATE OR REPLACE FUNCTION protect_inventory_provider_reservation_release_intents()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_provider_reservation_release_intent_is_immutable'
    USING ERRCODE='55000';
END $$;

CREATE TRIGGER inventory_provider_reservation_release_intents_immutable
BEFORE UPDATE OR DELETE ON inventory_provider_reservation_release_intents
FOR EACH ROW EXECUTE FUNCTION protect_inventory_provider_reservation_release_intents();

CREATE OR REPLACE FUNCTION reject_inventory_provider_reservation_release_intents_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_provider_reservation_release_intents_cannot_be_truncated'
    USING ERRCODE='55000';
END $$;

CREATE TRIGGER inventory_provider_reservation_release_intents_no_truncate
BEFORE TRUNCATE ON inventory_provider_reservation_release_intents
FOR EACH STATEMENT EXECUTE FUNCTION reject_inventory_provider_reservation_release_intents_truncate();
