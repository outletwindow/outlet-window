\set ON_ERROR_STOP on
BEGIN;

INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('provider-evidence-order','provider-evidence-tenant','provider-evidence-customer',
        'provider-evidence-order-key','awaiting_payment','SAR',5000);
INSERT INTO merchants (id,tenant_id,legal_name,display_name,country_code,status)
VALUES ('provider-evidence-merchant','provider-evidence-tenant','Provider Evidence LLC',
        'Provider Evidence','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('provider-evidence-branch','provider-evidence-merchant','Provider Evidence Branch','JUB','active');
INSERT INTO tenant_integrations
(id,tenant_id,family,provider_key,display_name,status,capabilities,created_at,updated_at)
VALUES ('provider-evidence-pos','provider-evidence-tenant','pos','pos-evidence','Evidence POS',
        'connected','["inventory.hard_reservation"]',now(),now());
INSERT INTO merchant_inventory_provider_branch_scopes
(tenant_id,integration_id,merchant_id,branch_id)
VALUES ('provider-evidence-tenant','provider-evidence-pos',
        'provider-evidence-merchant','provider-evidence-branch');
INSERT INTO merchant_suborders
(id,order_id,tenant_id,merchant_id,branch_id,status,version)
VALUES ('provider-evidence-suborder','provider-evidence-order','provider-evidence-tenant',
        'provider-evidence-merchant','provider-evidence-branch','awaiting_payment',1);
INSERT INTO verified_order_payment_captures
(id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,
 amount_minor,currency,captured_at,idempotency_key)
VALUES ('provider-evidence-capture','provider-evidence-tenant','provider-evidence-order',
        'moyasar','provider-evidence-event','provider-evidence-payment',
        5000,'SAR',now(),'provider-evidence-capture-key');
INSERT INTO commerce_catalog_variants
(id,tenant_id,product_id,sku,external_variant_id,status,created_at,updated_at)
VALUES ('provider-evidence-variant','provider-evidence-tenant','provider-evidence-product',
        'SKU-EVIDENCE','external-evidence-variant','active',now(),now());
INSERT INTO customer_order_items
(id,tenant_id,order_id,suborder_id,merchant_id,branch_id,product_variant_id,sku,quantity,unit_price_minor,currency)
VALUES ('provider-evidence-item','provider-evidence-tenant','provider-evidence-order',
        'provider-evidence-suborder','provider-evidence-merchant','provider-evidence-branch',
        'provider-evidence-variant','SKU-EVIDENCE',2,2500,'SAR');
INSERT INTO branch_inventory
(merchant_id,branch_id,product_variant_id,sku,available_quantity,reserved_quantity,source,last_synced_at,availability_confidence)
VALUES ('provider-evidence-merchant','provider-evidence-branch','external-evidence-variant',
        'SKU-EVIDENCE',8,0,'pos',now(),'high');

INSERT INTO inventory_reservations
(id,tenant_id,order_id,suborder_id,merchant_id,branch_id,idempotency_key,status,requested_at,expires_at)
VALUES ('provider-evidence-reservation','provider-evidence-tenant','provider-evidence-order',
        'provider-evidence-suborder','provider-evidence-merchant','provider-evidence-branch',
        'provider-evidence-idempotency','reserved',now(),now()+interval '15 minutes');
INSERT INTO inventory_reservation_lines
(reservation_id,merchant_id,branch_id,product_variant_id,sku,quantity,catalog_variant_id)
VALUES ('provider-evidence-reservation','provider-evidence-merchant','provider-evidence-branch',
        'external-evidence-variant','SKU-EVIDENCE',2,'provider-evidence-variant');
INSERT INTO inventory_provider_reservation_evidence
(tenant_id,reservation_id,integration_id,provider_key,provider_reservation_reference,expires_at)
VALUES ('provider-evidence-tenant','provider-evidence-reservation','provider-evidence-pos',
        'pos-evidence','external-hold-1',now()+interval '15 minutes');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM inventory_provider_reservation_evidence e
    JOIN inventory_reservations r ON r.tenant_id=e.tenant_id AND r.id=e.reservation_id
    JOIN inventory_reservation_lines l ON l.reservation_id=r.id
    WHERE e.tenant_id='provider-evidence-tenant'
      AND e.integration_id='provider-evidence-pos'
      AND e.provider_reservation_reference='external-hold-1'
      AND l.catalog_variant_id='provider-evidence-variant'
      AND l.product_variant_id='external-evidence-variant'
      AND r.status='reserved'
  ) THEN RAISE EXCEPTION 'external reservation evidence was not linked to local reservation ledger'; END IF;

  BEGIN
    INSERT INTO inventory_provider_reservation_evidence
    (tenant_id,reservation_id,integration_id,provider_key,provider_reservation_reference,expires_at)
    VALUES ('provider-evidence-tenant','provider-evidence-reservation','provider-evidence-pos',
            'pos-evidence','external-hold-1',now()+interval '15 minutes');
    RAISE EXCEPTION 'duplicate external provider reservation reference unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

ROLLBACK;
