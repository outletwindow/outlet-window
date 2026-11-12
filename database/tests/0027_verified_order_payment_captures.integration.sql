\set ON_ERROR_STOP on
BEGIN;
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('payment-ci-order','platform','payment-ci-customer','payment-ci-idempotency-001','awaiting_payment','SAR',12500);

INSERT INTO verified_order_payment_captures
(id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,amount_minor,currency,captured_at,idempotency_key)
VALUES
('payment-ci-capture','platform','payment-ci-order','test_psp','evt-payment-ci-001','pay-payment-ci-001',12500,'SAR',now(),'payment-ci-idempotency-001');

DO $$
BEGIN
  BEGIN
    INSERT INTO verified_order_payment_captures
    (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,amount_minor,currency,captured_at,idempotency_key)
    VALUES
    ('payment-ci-mismatch','platform','payment-ci-order','test_psp','evt-payment-ci-002','pay-payment-ci-002',12499,'SAR',now(),'payment-ci-idempotency-002');
    RAISE EXCEPTION 'amount mismatch unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO verified_order_payment_captures
    (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,amount_minor,currency,captured_at,idempotency_key)
    VALUES
    ('payment-ci-duplicate-event','platform','payment-ci-order','test_psp','evt-payment-ci-001','pay-payment-ci-duplicate',12500,'SAR',now(),'payment-ci-idempotency-003');
    RAISE EXCEPTION 'duplicate provider event unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO verified_order_payment_captures
    (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,amount_minor,currency,captured_at,idempotency_key)
    VALUES
    ('payment-ci-duplicate-reference','platform','payment-ci-order','test_psp','evt-payment-ci-003','pay-payment-ci-001',12500,'SAR',now(),'payment-ci-idempotency-004');
    RAISE EXCEPTION 'duplicate provider payment reference unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    UPDATE verified_order_payment_captures SET amount_minor=1 WHERE id='payment-ci-capture';
    RAISE EXCEPTION 'capture mutation unexpectedly accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM verified_order_payment_captures
    WHERE tenant_id='platform' AND order_id='payment-ci-order'
      AND amount_minor=12500 AND currency='SAR'
  ) THEN RAISE EXCEPTION 'exact verified capture missing'; END IF;
END $$;
ROLLBACK;
