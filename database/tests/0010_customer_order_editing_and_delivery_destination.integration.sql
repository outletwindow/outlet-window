\set ON_ERROR_STOP on
BEGIN;

INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('ci-order-edit-window','platform','ci-edit-customer',
  'ci-edit-order-idem','confirmed','SAR',20000);

INSERT INTO scheduled_order_confirmations
  (order_id,tenant_id,payment_reference,payment_captured_at,confirmed_at,fulfillment_version)
VALUES ('ci-order-edit-window','platform','ci-edit-payment-ref',
  '2026-11-08T12:00:00Z','2026-11-08T12:00:01Z',1);

DO $$
DECLARE deadline timestamptz;
BEGIN
  SELECT customer_edit_until INTO deadline
  FROM scheduled_order_confirmations WHERE order_id = 'ci-order-edit-window';
  IF deadline <> '2026-11-08T12:00:05Z'::timestamptz THEN
    RAISE EXCEPTION 'paid order edit deadline must be exactly five seconds after capture';
  END IF;

  UPDATE customer_orders
  SET delivery_destination = '{"latitude":27.01,"longitude":49.65}'::jsonb,
      delivery_quote = '{"branchId":"branch-1","deliveryFeeMinor":1500,"totalMinor":21500,"currency":"SAR"}'::jsonb,
      delivery_zone_id = 'jubail-zone',
      delivery_branch_id = 'branch-1'
  WHERE id = 'ci-order-edit-window';

  IF NOT EXISTS (
    SELECT 1 FROM customer_orders
    WHERE id = 'ci-order-edit-window'
      AND delivery_destination->>'latitude' = '27.01'
      AND delivery_quote->>'branchId' = 'branch-1'
      AND delivery_zone_id = 'jubail-zone'
      AND delivery_branch_id = 'branch-1'
  ) THEN RAISE EXCEPTION 'delivery destination and quote snapshot were not stored'; END IF;

  INSERT INTO customer_order_edit_events
    (id,tenant_id,order_id,actor_id,edit_type,occurred_at,previous_snapshot,next_snapshot,quote_reference)
  VALUES ('ci-edit-event','platform','ci-order-edit-window','ci-edit-customer',
    'delivery_destination',now(),'{"branchId":"branch-old"}',
    '{"branchId":"branch-1"}','ci-quote-ref');

  BEGIN
    UPDATE customer_order_edit_events SET actor_id = 'tampered' WHERE id = 'ci-edit-event';
    RAISE EXCEPTION 'edit event mutation unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'customer_order_edit_events_are_append_only' THEN RAISE; END IF;
  END;
END $$;

ROLLBACK;
