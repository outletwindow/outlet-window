-- Configurable geographic service areas and versioned, approval-gated pricing rules.
-- No live market rates are seeded by this migration.
CREATE TABLE IF NOT EXISTS delivery_service_areas (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  country_code char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  city_code text NOT NULL CHECK (length(trim(city_code)) BETWEEN 1 AND 80),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 120),
  center_latitude numeric(9,6) NOT NULL CHECK (center_latitude BETWEEN -90 AND 90),
  center_longitude numeric(9,6) NOT NULL CHECK (center_longitude BETWEEN -180 AND 180),
  radius_meters integer NOT NULL CHECK (radius_meters BETWEEN 100 AND 100000),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('draft','active','suspended','retired')),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  created_by text NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);
CREATE INDEX IF NOT EXISTS delivery_service_areas_lookup_idx
  ON delivery_service_areas (tenant_id, country_code, city_code, status, effective_from);

CREATE TABLE IF NOT EXISTS delivery_service_area_branches (
  tenant_id text NOT NULL,
  service_area_id text NOT NULL,
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, service_area_id, merchant_id, branch_id),
  FOREIGN KEY (tenant_id, service_area_id)
    REFERENCES delivery_service_areas(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, branch_id)
    REFERENCES merchant_branches(merchant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS delivery_service_area_branches_branch_idx
  ON delivery_service_area_branches (merchant_id, branch_id, tenant_id);

CREATE TABLE IF NOT EXISTS delivery_pricing_rules (
  id text NOT NULL,
  tenant_id text NOT NULL,
  service_area_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  service_code text NOT NULL CHECK (length(trim(service_code)) BETWEEN 1 AND 80),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  calculation_config jsonb NOT NULL CHECK (jsonb_typeof(calculation_config) = 'object'),
  status text NOT NULL CHECK (status IN ('draft','pending_approval','approved','active','suspended','retired')),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  created_by text NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 200),
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id, version),
  FOREIGN KEY (tenant_id, service_area_id)
    REFERENCES delivery_service_areas(tenant_id, id) ON DELETE RESTRICT,
  CHECK (effective_until IS NULL OR effective_until > effective_from),
  CHECK (
    (status IN ('approved','active','suspended','retired') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR status IN ('draft','pending_approval')
  ),
  CHECK (approved_by IS NULL OR length(trim(approved_by)) BETWEEN 1 AND 200),
  CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX IF NOT EXISTS delivery_pricing_rules_active_lookup_idx
  ON delivery_pricing_rules (tenant_id, service_area_id, service_code, currency, status, effective_from DESC);

CREATE TABLE IF NOT EXISTS delivery_pricing_rule_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  rule_id text NOT NULL,
  rule_version integer NOT NULL,
  actor_id text NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (event_type IN ('created','submitted','approved','activated','suspended','retired')),
  occurred_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  FOREIGN KEY (tenant_id, rule_id, rule_version)
    REFERENCES delivery_pricing_rules(tenant_id, id, version) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS delivery_pricing_rule_events_history_idx
  ON delivery_pricing_rule_events (tenant_id, rule_id, rule_version, occurred_at, id);

CREATE OR REPLACE FUNCTION prevent_delivery_pricing_rule_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'delivery_pricing_rule_events_are_append_only';
END;
$function$;
DROP TRIGGER IF EXISTS delivery_pricing_rule_events_no_update ON delivery_pricing_rule_events;
CREATE TRIGGER delivery_pricing_rule_events_no_update
BEFORE UPDATE OR DELETE ON delivery_pricing_rule_events
FOR EACH ROW EXECUTE FUNCTION prevent_delivery_pricing_rule_event_mutation();

-- Prevent activating an unapproved rule, or changing an approved rule's commercial snapshot.
CREATE OR REPLACE FUNCTION guard_delivery_pricing_rule_approval()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.status = 'active' AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL) THEN
    RAISE EXCEPTION 'pricing_rule_requires_approval';
  END IF;
  IF OLD.approved_at IS NOT NULL AND (
    NEW.calculation_config IS DISTINCT FROM OLD.calculation_config OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.service_area_id IS DISTINCT FROM OLD.service_area_id OR
    NEW.effective_from IS DISTINCT FROM OLD.effective_from OR
    NEW.effective_until IS DISTINCT FROM OLD.effective_until
  ) THEN
    RAISE EXCEPTION 'approved_pricing_rule_snapshot_is_immutable';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS delivery_pricing_rules_approval_guard ON delivery_pricing_rules;
CREATE TRIGGER delivery_pricing_rules_approval_guard
BEFORE UPDATE ON delivery_pricing_rules
FOR EACH ROW EXECUTE FUNCTION guard_delivery_pricing_rule_approval();
