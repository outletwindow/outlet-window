\set ON_ERROR_STOP on
BEGIN;
INSERT INTO tenants (id,tenant_type,display_name,status) VALUES ('pia-tenant','platform','Payment Intent Attempt Test Tenant','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('pia-order','pia-tenant','pia-customer','pia-order-idem','awaiting_payment','SAR',12500);
INSERT INTO payment_intent_creation_attempts
(id,tenant_id,order_id,provider_key,idempotency_key,amount_minor,currency,status)
VALUES ('pia-1','pia-tenant','pia-order','moyasar','pia-idem-0001',12500,'SAR','dispatching');
DO $$ BEGIN
 BEGIN
  INSERT INTO payment_intent_creation_attempts
  (id,tenant_id,order_id,provider_key,idempotency_key,amount_minor,currency,status)
  VALUES ('pia-duplicate-order','pia-tenant','pia-order','moyasar','pia-idem-0002',12500,'SAR','dispatching');
  RAISE EXCEPTION 'expected one active attempt per order/provider';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  UPDATE payment_intent_creation_attempts SET status='rejected',failure_code='NOPE' WHERE id='pia-1';
  RAISE EXCEPTION 'expected invalid state transition rejection';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE payment_intent_creation_attempts SET status='outcome_unknown' WHERE id='pia-1';
DO $$ BEGIN
 BEGIN
  UPDATE payment_intent_creation_attempts SET status='rejected',failure_code='PROVIDER_CONFIRMED_ABSENT' WHERE id='pia-1';
  RAISE EXCEPTION 'expected reconciliation evidence requirement';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE payment_intent_creation_attempts SET status='rejected',failure_code='PROVIDER_CONFIRMED_ABSENT',
 provider_reconciliation_reference='provider-reconciliation-1' WHERE id='pia-1';
DO $$ BEGIN
 BEGIN
  DELETE FROM payment_intent_creation_attempts WHERE id='pia-1';
  RAISE EXCEPTION 'expected append-only attempt ledger';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
END $$;
ROLLBACK;
