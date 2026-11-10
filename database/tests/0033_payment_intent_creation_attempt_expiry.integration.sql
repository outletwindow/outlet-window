\set ON_ERROR_STOP on
BEGIN;
INSERT INTO tenants (id,tenant_type,display_name,status) VALUES ('pia-expiry-tenant','platform','Payment Intent Expiry Test Tenant','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('pia-expiry-order','pia-expiry-tenant','pia-expiry-customer','pia-expiry-order-idem','awaiting_payment','SAR',12500);
INSERT INTO payment_intent_creation_attempts
(id,tenant_id,order_id,provider_key,idempotency_key,amount_minor,currency,status)
VALUES ('pia-expiry-1','pia-expiry-tenant','pia-expiry-order','moyasar','pia-expiry-idem-01',12500,'SAR','dispatching');
UPDATE payment_intent_creation_attempts
SET status='created',provider_payment_reference='provider-expiry-ref-1',
    expires_at=clock_timestamp()+interval '1 second'
WHERE id='pia-expiry-1';
SELECT pg_sleep(1.1);
DO $$ BEGIN
 BEGIN
  UPDATE payment_intent_creation_attempts
  SET status='expired',failure_code='PROVIDER_INTENT_EXPIRED'
  WHERE id='pia-expiry-1';
  RAISE EXCEPTION 'expected provider reconciliation evidence';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE payment_intent_creation_attempts
SET status='expired',failure_code='PROVIDER_INTENT_EXPIRED',
    provider_reconciliation_reference='provider-expiry-check-1'
WHERE id='pia-expiry-1';
DO $$ BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM payment_intent_creation_attempts
   WHERE id='pia-expiry-1' AND status='expired'
     AND provider_payment_reference='provider-expiry-ref-1'
     AND expires_at <= clock_timestamp()
     AND provider_reconciliation_reference='provider-expiry-check-1'
 ) THEN RAISE EXCEPTION 'expired attempt must preserve provider identity and reconciliation evidence'; END IF;
END $$;
INSERT INTO payment_intent_creation_attempts
(id,tenant_id,order_id,provider_key,idempotency_key,amount_minor,currency,status)
VALUES ('pia-expiry-2','pia-expiry-tenant','pia-expiry-order','moyasar','pia-expiry-idem-02',12500,'SAR','dispatching');
ROLLBACK;
