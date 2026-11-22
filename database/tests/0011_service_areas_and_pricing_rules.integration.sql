BEGIN;

INSERT INTO delivery_service_areas (
  id, tenant_id, country_code, city_code, display_name, center_latitude,
  center_longitude, radius_meters, currency, status, effective_from, created_by
) VALUES (
  'test-area', 'tenant-test', 'SA', 'JUBAIL', 'Test area', 27.004600,
  49.646000, 10000, 'SAR', 'active', now() - interval '1 minute', 'test-admin'
);

INSERT INTO delivery_pricing_rules (
  id, tenant_id, service_area_id, version, service_code, currency,
  calculation_config, status, effective_from, created_by
) VALUES (
  'test-rule', 'tenant-test', 'test-area', 1, 'standard_delivery', 'SAR',
  '{"method":"fixed_plus_distance","base_fee_minor":1000,"per_km_minor":200}',
  'draft', now(), 'test-admin'
);

DO $$
BEGIN
  BEGIN
    UPDATE delivery_pricing_rules SET status = 'active'
    WHERE tenant_id = 'tenant-test' AND id = 'test-rule' AND version = 1;
    RAISE EXCEPTION 'unapproved pricing rule unexpectedly activated';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'pricing_rule_requires_approval' THEN RAISE; END IF;
  END;
END $$;

UPDATE delivery_pricing_rules
SET status = 'approved', approved_by = 'finance-reviewer', approved_at = now()
WHERE tenant_id = 'tenant-test' AND id = 'test-rule' AND version = 1;

UPDATE delivery_pricing_rules
SET status = 'active'
WHERE tenant_id = 'tenant-test' AND id = 'test-rule' AND version = 1;

DO $$
BEGIN
  BEGIN
    UPDATE delivery_pricing_rules
    SET calculation_config = '{"method":"fixed","base_fee_minor":1}'
    WHERE tenant_id = 'tenant-test' AND id = 'test-rule' AND version = 1;
    RAISE EXCEPTION 'approved pricing snapshot unexpectedly changed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'approved_pricing_rule_snapshot_is_immutable' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO delivery_pricing_rule_events (
  id, tenant_id, rule_id, rule_version, actor_id, event_type, occurred_at, snapshot
) VALUES ('test-event', 'tenant-test', 'test-rule', 1, 'finance-reviewer',
          'approved', now(), '{"approved":true}');

DO $$
BEGIN
  BEGIN
    UPDATE delivery_pricing_rule_events SET actor_id = 'tampered' WHERE id = 'test-event';
    RAISE EXCEPTION 'pricing rule event unexpectedly mutable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'delivery_pricing_rule_events_are_append_only' THEN RAISE; END IF;
  END;
END $$;

ROLLBACK;
