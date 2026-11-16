\set ON_ERROR_STOP on
BEGIN;

INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('single-capture-order','platform','single-capture-customer','single-capture-order-key','awaiting_payment','SAR',12500);

INSERT INTO verified_order_payment_captures
(id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,amount_minor,currency,captured_at,idempotency_key)
VALUES
('single-capture-first','platform','single-capture-order','moyasar','single-capture-event-1','single-capture-ref-1',12500,'SAR',now(),'single-capture-key-1');

DO $$
BEGIN
  BEGIN
    INSERT INTO verified_order_payment_captures
    (id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,amount_minor,currency,captured_at,idempotency_key)
    VALUES
    ('single-capture-second','platform','single-capture-order','other_psp','single-capture-event-2','single-capture-ref-2',12500,'SAR',now(),'single-capture-key-2');
    RAISE EXCEPTION 'second initial capture for the same order unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM verified_order_payment_captures
      WHERE tenant_id='platform' AND order_id='single-capture-order') <> 1 THEN
    RAISE EXCEPTION 'order must retain exactly one initial payment capture';
  END IF;
END $$;

ROLLBACK;
