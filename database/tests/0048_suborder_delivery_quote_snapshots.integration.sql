\set ON_ERROR_STOP on
BEGIN;

INSERT INTO merchants (id,tenant_id,legal_name,display_name,country_code,status)
VALUES ('quote-snapshot-merchant','quote-snapshot-tenant','Quote Snapshot LLC',
        'Quote Snapshot','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('quote-snapshot-branch','quote-snapshot-merchant','Quote Snapshot Branch','JUB','active');
INSERT INTO delivery_service_areas
(id,tenant_id,country_code,city_code,display_name,center_latitude,center_longitude,
 radius_meters,currency,status,effective_from,created_by)
VALUES ('quote-snapshot-area','platform','SA','JUB','Quote Snapshot Area',
        27.0046,49.6225,20000,'SAR','active',now()-interval '1 day','quote-snapshot-test');
INSERT INTO delivery_pricing_rules
(id,tenant_id,service_area_id,version,service_code,currency,calculation_config,
 status,effective_from,created_by,approved_by,approved_at)
VALUES ('quote-snapshot-rule','platform','quote-snapshot-area',1,'standard','SAR',
        '{"method":"fixed_plus_distance","base_fee_minor":1000,"per_km_minor":100}'::jsonb,
        'active',now()-interval '1 day','quote-snapshot-test','quote-snapshot-approver',now());
INSERT INTO delivery_service_area_branches
(tenant_id,service_area_id,merchant_id,branch_id)
VALUES ('platform','quote-snapshot-area','quote-snapshot-merchant','quote-snapshot-branch');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('quote-snapshot-order','platform','quote-snapshot-customer','quote-snapshot-key-1','pending_validation','SAR',5000),
       ('quote-snapshot-other-order','platform','quote-snapshot-customer','quote-snapshot-key-2','pending_validation','SAR',5000);
INSERT INTO merchant_suborders
(id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('quote-snapshot-suborder','quote-snapshot-tenant','quote-snapshot-order',
        'quote-snapshot-merchant','quote-snapshot-branch','pending_validation',4000),
       ('quote-snapshot-other-suborder','quote-snapshot-tenant','quote-snapshot-other-order',
        'quote-snapshot-merchant','quote-snapshot-branch','pending_validation',4000);

INSERT INTO customer_order_suborder_delivery_quotes
(id,tenant_id,order_id,suborder_id,merchant_id,branch_id,service_area_tenant_id,
 service_area_id,pricing_rule_id,pricing_rule_version,quote_snapshot,currency,total_minor,
 created_at,expires_at)
VALUES ('quote-snapshot-valid','quote-snapshot-tenant','quote-snapshot-order',
        'quote-snapshot-suborder','quote-snapshot-merchant','quote-snapshot-branch',
        'platform','quote-snapshot-area','quote-snapshot-rule',1,
        '{"quoteId":"quote-snapshot-valid","ruleId":"quote-snapshot-rule","ruleVersion":1,"currency":"SAR","subtotalMinor":1000,"discountMinor":0,"totalMinor":1000,"components":[{"kind":"delivery","amountMinor":1000,"label":"Delivery"}],"createdAtUtc":"2026-11-14T19:00:00.000Z","expiresAtUtc":"2026-11-14T19:05:00.000Z"}'::jsonb,
        'SAR',1000,now(),now()+interval '5 minutes');

DO $$
BEGIN
  BEGIN
    INSERT INTO customer_order_suborder_delivery_quotes
    (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,service_area_tenant_id,
     service_area_id,pricing_rule_id,pricing_rule_version,quote_snapshot,currency,total_minor,
     created_at,expires_at)
    VALUES ('quote-snapshot-wrong-order','quote-snapshot-tenant','quote-snapshot-order',
            'quote-snapshot-other-suborder','quote-snapshot-merchant','quote-snapshot-branch',
            'platform','quote-snapshot-area','quote-snapshot-rule',1,
            '{"quoteId":"wrong-order"}'::jsonb,'SAR',1000,now(),now()+interval '5 minutes');
    RAISE EXCEPTION 'cross-order quote snapshot unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO customer_order_suborder_delivery_quotes
    (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,service_area_tenant_id,
     service_area_id,pricing_rule_id,pricing_rule_version,quote_snapshot,currency,total_minor,
     created_at,expires_at)
    VALUES ('quote-snapshot-invalid-window','quote-snapshot-tenant','quote-snapshot-order',
            'quote-snapshot-suborder','quote-snapshot-merchant','quote-snapshot-branch',
            'platform','quote-snapshot-area','quote-snapshot-rule',1,
            '{"quoteId":"invalid-window"}'::jsonb,'SAR',1000,now(),now());
    RAISE EXCEPTION 'non-positive quote validity window unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO customer_order_suborder_delivery_quotes
    (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,service_area_tenant_id,
     service_area_id,pricing_rule_id,pricing_rule_version,quote_snapshot,currency,total_minor,
     created_at,expires_at)
    VALUES ('quote-snapshot-mismatched-total','quote-snapshot-tenant','quote-snapshot-order',
            'quote-snapshot-suborder','quote-snapshot-merchant','quote-snapshot-branch',
            'platform','quote-snapshot-area','quote-snapshot-rule',1,
            '{"quoteId":"quote-snapshot-mismatched-total","ruleId":"quote-snapshot-rule","ruleVersion":1,"currency":"SAR","totalMinor":999,"components":[],"createdAtUtc":"2026-11-14T19:00:00.000Z","expiresAtUtc":"2026-11-14T19:05:00.000Z"}'::jsonb,
            'SAR',1000,now(),now()+interval '5 minutes');
    RAISE EXCEPTION 'quote snapshot total mismatch unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE customer_order_suborder_delivery_quotes
    SET total_minor=2000 WHERE id='quote-snapshot-valid';
    RAISE EXCEPTION 'immutable quote snapshot unexpectedly updated';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    DELETE FROM customer_order_suborder_delivery_quotes WHERE id='quote-snapshot-valid';
    RAISE EXCEPTION 'immutable quote snapshot unexpectedly deleted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    TRUNCATE customer_order_suborder_delivery_quotes;
    RAISE EXCEPTION 'quote snapshot ledger unexpectedly truncated';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;

ROLLBACK;
