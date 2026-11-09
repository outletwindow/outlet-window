BEGIN;
INSERT INTO merchants (id, tenant_id, legal_name, display_name, country_code, status)
VALUES ('scope-merchant','scope-tenant','Scope Merchant LLC','Scope Merchant','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('scope-branch','scope-merchant','Scope Branch','DMM','active');
INSERT INTO tenant_integrations
(id,tenant_id,family,provider_key,display_name,status,capabilities,created_at,updated_at)
VALUES ('scope-carrier','scope-tenant','carriers','carrier-a','Carrier A','connected','[]',
        now(),now());
INSERT INTO fulfillment_provider_branch_scopes
(tenant_id,integration_id,merchant_id,branch_id)
VALUES ('scope-tenant','scope-carrier','scope-merchant','scope-branch');
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM fulfillment_provider_branch_scopes s
    JOIN tenant_integrations i ON i.tenant_id=s.tenant_id AND i.id=s.integration_id
    WHERE s.tenant_id='scope-tenant' AND s.integration_id='scope-carrier'
      AND s.merchant_id='scope-merchant' AND s.branch_id='scope-branch'
      AND s.active AND i.family='carriers' AND i.provider_key='carrier-a' AND i.status='connected'
  ) THEN RAISE EXCEPTION 'valid carrier branch scope was not found'; END IF;
  IF EXISTS (
    SELECT 1 FROM fulfillment_provider_branch_scopes s
    WHERE s.tenant_id='scope-tenant' AND s.integration_id='scope-carrier'
      AND s.merchant_id='scope-merchant' AND s.branch_id='other-branch' AND s.active
  ) THEN RAISE EXCEPTION 'unexpected branch scope'; END IF;
END $$;
DO $$
BEGIN
  BEGIN
    INSERT INTO fulfillment_provider_branch_scopes
    (tenant_id,integration_id,merchant_id,branch_id)
    VALUES ('other-tenant','scope-carrier','scope-merchant','scope-branch');
    RAISE EXCEPTION 'cross-tenant integration scope unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
ROLLBACK;
