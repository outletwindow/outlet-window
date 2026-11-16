\set ON_ERROR_STOP on
BEGIN;
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('positive-capture-ci-order','platform','positive-capture-ci-customer','positive-capture-ci-001','awaiting_payment','SAR',0);

DO $$
BEGIN
  BEGIN
    INSERT INTO verified_order_payment_captures
    (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,amount_minor,currency,captured_at,idempotency_key)
    VALUES
    ('positive-capture-ci-zero','platform','positive-capture-ci-order','test_psp','evt-positive-ci-001','pay-positive-ci-001',0,'SAR',now(),'positive-capture-ci-key-001');
    RAISE EXCEPTION 'zero-value verified capture unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='verified_order_payment_captures'::regclass
      AND conname='verified_order_payment_captures_amount_minor_positive'
  ) THEN RAISE EXCEPTION 'positive capture amount constraint missing'; END IF;
END $$;
ROLLBACK;
