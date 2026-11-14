BEGIN;
INSERT INTO merchants (id, tenant_id, legal_name, display_name, country_code, status)
VALUES ('inventory-scope-merchant','inventory-scope-tenant','Inventory Scope LLC','Inventory Scope','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('inventory-scope-branch','inventory-scope-merchant','Inventory Scope Branch','JUB','active');
INSERT INTO tenant_integrations
(id,tenant_id,family,provider_key,display_name,status,capabilities,created_at,updated_at)
VALUES
('inventory-scope-pos','inventory-scope-tenant','pos','pos-acme','Acme POS','connected','["inventory.read","inventory.hard_reservation"]',now(),now()),
('inventory-scope-erp','inventory-scope-tenant','erp','erp-acme','Acme ERP','connected','["inventory.read"]',now(),now());
INSERT INTO merchant_inventory_provider_branch_scopes
(tenant_id,integration_id,merchant_id,branch_id)
VALUES ('inventory-scope-tenant','inventory-scope-pos','inventory-scope-merchant','inventory-scope-branch');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tenant_integrations i
    JOIN merchant_inventory_provider_branch_scopes s
      ON s.tenant_id=i.tenant_id AND s.integration_id=i.id
    JOIN merchants m ON m.tenant_id=i.tenant_id AND m.id=s.merchant_id
    JOIN merchant_branches b ON b.merchant_id=s.merchant_id AND b.id=s.branch_id
    WHERE i.id='inventory-scope-pos' AND i.family IN ('pos','erp')
      AND i.status='connected'
      AND i.capabilities @> '["inventory.hard_reservation"]'::jsonb
      AND s.active AND m.status='active' AND b.status='active'
  ) THEN RAISE EXCEPTION 'eligible POS inventory scope was not found'; END IF;

  IF EXISTS (
    SELECT 1 FROM tenant_integrations i
    JOIN merchant_inventory_provider_branch_scopes s
      ON s.tenant_id=i.tenant_id AND s.integration_id=i.id
    WHERE i.id='inventory-scope-erp'
      AND i.capabilities @> '["inventory.hard_reservation"]'::jsonb
  ) THEN RAISE EXCEPTION 'read-only ERP integration gained hard reservation capability'; END IF;

  BEGIN
    INSERT INTO merchant_inventory_provider_branch_scopes
    (tenant_id,integration_id,merchant_id,branch_id)
    VALUES ('other-tenant','inventory-scope-pos','inventory-scope-merchant','inventory-scope-branch');
    RAISE EXCEPTION 'cross-tenant inventory scope unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
ROLLBACK;
