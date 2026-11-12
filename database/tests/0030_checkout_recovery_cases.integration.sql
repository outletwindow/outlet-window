\set ON_ERROR_STOP on
BEGIN;
INSERT INTO checkout_recovery_cases
(id,tenant_id,order_id,idempotency_key,failure_code,failed_suborder_id,
 payment_reference,payment_captured_at,reservation_references)
VALUES
('recovery-test-1','tenant-test','order-test','checkout-recovery:order-test:1',
 'INVENTORY_UNAVAILABLE','suborder-2','capture-ref-1',now(),
 '[{"suborderId":"suborder-1","reservationReference":"reservation-1"}]'::jsonb);
DO $$ BEGIN
  BEGIN
    INSERT INTO checkout_recovery_cases
    (id,tenant_id,order_id,idempotency_key,failure_code,payment_reference,
     payment_captured_at,reservation_references)
    VALUES ('recovery-test-duplicate','tenant-test','order-test',
      'checkout-recovery:order-test:1','INVENTORY_UNAVAILABLE','capture-ref-1',now(),'[]'::jsonb);
    RAISE EXCEPTION 'expected unique recovery idempotency key rejection';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO checkout_recovery_cases
    (id,tenant_id,order_id,idempotency_key,failure_code,payment_reference,
     payment_captured_at,reservation_references)
    VALUES ('recovery-test-invalid','tenant-test','order-test',
      'checkout-recovery:order-test:2','UNRECOGNIZED_FAILURE','capture-ref-1',now(),'[]'::jsonb);
    RAISE EXCEPTION 'expected failure code constraint rejection';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO checkout_recovery_cases
    (id,tenant_id,order_id,idempotency_key,failure_code,payment_reference,
     payment_captured_at,reservation_references)
    VALUES ('recovery-test-invalid-json','tenant-test','order-test',
      'checkout-recovery:order-test:3','TASK_COMMIT_REJECTED','capture-ref-1',now(),'{}'::jsonb);
    RAISE EXCEPTION 'expected reservation array constraint rejection';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE checkout_recovery_cases SET status='resolved' WHERE id='recovery-test-1';
    RAISE EXCEPTION 'expected resolution evidence constraint rejection';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE checkout_recovery_cases
SET status='resolved',resolution_code='customer_refunded',resolved_at=now(),updated_at=now()
WHERE id='recovery-test-1';
ROLLBACK;
