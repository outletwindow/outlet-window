\set ON_ERROR_STOP on
BEGIN;
INSERT INTO tenants (id,tenant_type,display_name,status)
VALUES ('pi-tenant','platform','Payment Intent Test Tenant','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('pi-order','pi-tenant','pi-customer','pi-order-idem','awaiting_payment','SAR',12500);
INSERT INTO provider_payment_intents
(id,tenant_id,order_id,provider_key,provider_payment_reference,amount_minor,currency,idempotency_key,expires_at)
VALUES ('pi-1','pi-tenant','pi-order','psp-a','ref-1',12500,'SAR','pi-idem-0001',now()+interval '15 minutes');
DO $$ BEGIN
  BEGIN
    INSERT INTO provider_payment_intents
    (id,tenant_id,order_id,provider_key,provider_payment_reference,amount_minor,currency,idempotency_key,expires_at)
    VALUES ('pi-bad','pi-tenant','pi-order','psp-a','ref-bad',12000,'SAR','pi-idem-0002',now()+interval '15 minutes');
    RAISE EXCEPTION 'expected payment intent amount mismatch rejection';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE provider_payment_intents SET provider_payment_reference='tampered' WHERE id='pi-1';
    RAISE EXCEPTION 'expected immutable payment intent rejection';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
  BEGIN
    INSERT INTO provider_payment_intents
    (id,tenant_id,order_id,provider_key,provider_payment_reference,amount_minor,currency,idempotency_key,expires_at)
    VALUES ('pi-duplicate','pi-tenant','pi-order','psp-a','ref-1',12500,'SAR','pi-idem-0003',now()+interval '15 minutes');
    RAISE EXCEPTION 'expected duplicate provider reference rejection';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
ROLLBACK;
