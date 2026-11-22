-- Durable courier identity, verified vehicle capacity, availability and dispatch requirements.
-- Sensitive eligibility is checked again inside the offer acceptance transaction.
CREATE TABLE courier_profiles (
  courier_id text PRIMARY KEY REFERENCES identities(id) ON DELETE RESTRICT,
  account_status text NOT NULL CHECK (account_status IN ('pending','active','suspended')),
  verification_status text NOT NULL CHECK (verification_status IN ('pending','verified','rejected')),
  max_concurrent_tasks integer NOT NULL DEFAULT 1 CHECK (max_concurrent_tasks BETWEEN 1 AND 20),
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((verification_status = 'verified' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
      OR verification_status <> 'verified'),
  CHECK (approved_by IS NULL OR length(trim(approved_by)) BETWEEN 1 AND 200)
);
CREATE TABLE courier_availability (
  courier_id text PRIMARY KEY REFERENCES courier_profiles(courier_id) ON DELETE RESTRICT,
  available boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE courier_vehicles (
  id text PRIMARY KEY,
  courier_id text NOT NULL REFERENCES courier_profiles(courier_id) ON DELETE RESTRICT,
  vehicle_type text NOT NULL CHECK (vehicle_type IN ('motorcycle','car','van')),
  verification_status text NOT NULL CHECK (verification_status IN ('pending','verified','rejected')),
  capacity_weight_grams integer NOT NULL CHECK (capacity_weight_grams BETWEEN 1 AND 1000000),
  capacity_volume_liters integer NOT NULL CHECK (capacity_volume_liters BETWEEN 1 AND 10000),
  active boolean NOT NULL DEFAULT false,
  verified_by text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((verification_status = 'verified' AND verified_by IS NOT NULL AND verified_at IS NOT NULL)
      OR verification_status <> 'verified')
);
CREATE INDEX courier_vehicles_eligible_idx
 ON courier_vehicles(courier_id, vehicle_type, active)
 WHERE verification_status = 'verified' AND active = true;
CREATE TABLE courier_service_area_memberships (
  courier_id text NOT NULL REFERENCES courier_profiles(courier_id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  service_area_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  approved_by text NOT NULL CHECK (length(trim(approved_by)) BETWEEN 1 AND 200),
  approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (courier_id, tenant_id, service_area_id),
  FOREIGN KEY (tenant_id, service_area_id)
    REFERENCES delivery_service_areas(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX courier_service_area_memberships_active_idx
 ON courier_service_area_memberships(tenant_id, service_area_id, courier_id)
 WHERE active = true;

-- The dispatch service writes this trusted, immutable requirement snapshot before
-- generating offers. It is deliberately separate from merchant-editable metadata.
CREATE TABLE courier_dispatch_requirements (
  tenant_id text NOT NULL,
  suborder_id text NOT NULL,
  service_area_id text NOT NULL,
  accepted_vehicle_types jsonb NOT NULL
    CHECK (jsonb_typeof(accepted_vehicle_types) = 'array'
      AND jsonb_array_length(accepted_vehicle_types) BETWEEN 1 AND 3),
  package_weight_grams integer NOT NULL CHECK (package_weight_grams BETWEEN 1 AND 1000000),
  package_volume_liters integer NOT NULL CHECK (package_volume_liters BETWEEN 1 AND 10000),
  created_by text NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, suborder_id),
  FOREIGN KEY (tenant_id, suborder_id)
    REFERENCES merchant_suborders(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, service_area_id)
    REFERENCES delivery_service_areas(tenant_id, id) ON DELETE RESTRICT,
  CHECK (accepted_vehicle_types <@ '["motorcycle","car","van"]'::jsonb)
);
CREATE OR REPLACE FUNCTION prevent_courier_dispatch_requirement_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'courier_dispatch_requirements_are_immutable';
END;
$$;
CREATE TRIGGER courier_dispatch_requirements_no_update_delete
 BEFORE UPDATE OR DELETE ON courier_dispatch_requirements
 FOR EACH ROW EXECUTE FUNCTION prevent_courier_dispatch_requirement_mutation();
