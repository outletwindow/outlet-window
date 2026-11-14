\set ON_ERROR_STOP on
BEGIN;

INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES ('inventory-alert-merchant','Inventory Alert Merchant LLC','Inventory Alert Merchant','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('inventory-alert-branch','inventory-alert-merchant','Main Branch','JUB','active');

INSERT INTO branch_inventory_reconciliation_alerts
(id,tenant_id,merchant_id,branch_id,product_variant_id,source,captured_at,
 reported_available_quantity,platform_reserved_quantity)
VALUES
('inventory-alert-1','inventory-alert-merchant','inventory-alert-merchant',
 'inventory-alert-branch','variant-1','pos','2026-11-14T12:00:00Z',2,5);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM branch_inventory_reconciliation_alerts
    WHERE id='inventory-alert-1' AND status='open'
      AND reported_available_quantity=2 AND platform_reserved_quantity=5
  ) THEN
    RAISE EXCEPTION 'inventory reconciliation alert was not persisted';
  END IF;

  BEGIN
    INSERT INTO branch_inventory_reconciliation_alerts
    (id,tenant_id,merchant_id,branch_id,product_variant_id,source,captured_at,
     reported_available_quantity,platform_reserved_quantity)
    VALUES
    ('inventory-alert-duplicate','inventory-alert-merchant','inventory-alert-merchant',
     'inventory-alert-branch','variant-1','pos','2026-11-14T12:00:00Z',2,5);
    RAISE EXCEPTION 'duplicate discrepancy event unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    UPDATE branch_inventory_reconciliation_alerts SET status='resolved'
    WHERE id='inventory-alert-1';
    RAISE EXCEPTION 'resolved alert without resolved_at unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

ROLLBACK;
