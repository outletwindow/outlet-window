\set ON_ERROR_STOP on
BEGIN;

INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('paid-job-order','platform','paid-job-customer','paid-job-order-key','awaiting_payment','SAR',12500);

INSERT INTO verified_order_payment_captures
(id,tenant_id,order_id,provider_key,provider_event_id,provider_payment_reference,amount_minor,currency,captured_at,idempotency_key)
VALUES ('paid-job-capture','platform','paid-job-order','moyasar','paid-job-event','paid-job-ref',12500,'SAR',now(),'paid-job-capture-key');

INSERT INTO paid_checkout_inventory_reservation_jobs
(id,tenant_id,order_id,capture_id) VALUES
('paid-job-1','platform','paid-job-order','paid-job-capture')
ON CONFLICT (tenant_id,order_id) DO NOTHING;
INSERT INTO paid_checkout_inventory_reservation_jobs
(id,tenant_id,order_id,capture_id) VALUES
('paid-job-duplicate','platform','paid-job-order','paid-job-capture')
ON CONFLICT (tenant_id,order_id) DO NOTHING;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM paid_checkout_inventory_reservation_jobs
      WHERE tenant_id='platform' AND order_id='paid-job-order') <> 1 THEN
    RAISE EXCEPTION 'paid order must have exactly one reservation job';
  END IF;
  IF (SELECT capture_id FROM paid_checkout_inventory_reservation_jobs
      WHERE tenant_id='platform' AND order_id='paid-job-order') <> 'paid-job-capture' THEN
    RAISE EXCEPTION 'reservation job must reference the verified capture';
  END IF;
END $$;

-- A worker lease is represented atomically; a processing row cannot be left unowned.
UPDATE paid_checkout_inventory_reservation_jobs
SET status='processing',lease_owner='worker-1',lease_expires_at=now()+interval '30 seconds',
    attempt_count=attempt_count+1
WHERE id='paid-job-1' AND status='pending';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM paid_checkout_inventory_reservation_jobs
                 WHERE id='paid-job-1' AND status='processing'
                   AND lease_owner='worker-1' AND attempt_count=1) THEN
    RAISE EXCEPTION 'reservation job lease was not persisted';
  END IF;
END $$;

ROLLBACK;
