\set ON_ERROR_STOP on
BEGIN;

INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES ('merchant-order-reader-ci','Merchant Order Reader LLC','Order Reader','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES
  ('merchant-order-reader-branch','merchant-order-reader-ci','Reader Branch','DMM','active'),
  ('merchant-order-reader-other-branch','merchant-order-reader-ci','Other Branch','DMM','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('merchant-order-reader-order','platform','reader-customer','reader-order-key-001','confirmed','SAR',12500);
INSERT INTO merchant_suborders
  (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('merchant-order-reader-suborder','merchant-order-reader-ci','merchant-order-reader-order',
  'merchant-order-reader-ci','merchant-order-reader-branch','ready_for_pickup',12500);
INSERT INTO courier_delivery_tasks
  (id,tenant_id,suborder_id,courier_id,status,idempotency_key)
VALUES ('merchant-order-reader-task','merchant-order-reader-ci','merchant-order-reader-suborder',
  'reader-courier','arrived_at_pickup','reader-task-key-001');

DO $$
DECLARE
  found_count integer;
  found_order_id text;
  found_suborder_id text;
  found_task_id text;
  found_item_count integer;
  found_currency text;
BEGIN
  SELECT COUNT(*)::int, MAX(o.id), MAX(s.id), MAX(task.id),
         MAX((SELECT COUNT(*)::int FROM customer_order_items i
              WHERE i.tenant_id=s.tenant_id AND i.order_id=s.order_id AND i.suborder_id=s.id)),
         MAX(o.currency)
  INTO found_count, found_order_id, found_suborder_id, found_task_id, found_item_count, found_currency
  FROM merchant_suborders s
  JOIN customer_orders o ON o.id=s.order_id
  LEFT JOIN LATERAL (
    SELECT t.id, t.status, t.version
    FROM courier_delivery_tasks t
    WHERE t.tenant_id=s.tenant_id AND t.suborder_id=s.id
    ORDER BY t.offered_at DESC, t.created_at DESC
    LIMIT 1
  ) task ON TRUE
  WHERE s.tenant_id='merchant-order-reader-ci'
    AND s.merchant_id='merchant-order-reader-ci'
    AND s.branch_id='merchant-order-reader-branch';

  IF found_count <> 1 OR found_order_id <> 'merchant-order-reader-order'
     OR found_suborder_id <> 'merchant-order-reader-suborder'
     OR found_task_id <> 'merchant-order-reader-task'
     OR found_item_count <> 0 OR found_currency <> 'SAR' THEN
    RAISE EXCEPTION 'merchant branch order reader returned unexpected result';
  END IF;

  SELECT COUNT(*)::int INTO found_count
  FROM merchant_suborders s
  WHERE s.tenant_id='merchant-order-reader-ci'
    AND s.merchant_id='merchant-order-reader-ci'
    AND s.branch_id='merchant-order-reader-other-branch';
  IF found_count <> 0 THEN
    RAISE EXCEPTION 'merchant order reader leaked orders across branches';
  END IF;
END $$;

ROLLBACK;
