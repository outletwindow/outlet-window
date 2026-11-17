\set ON_ERROR_STOP on
BEGIN;

INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES ('refund-alloc-merchant','Refund Allocation Merchant LLC','Refund Allocation Merchant','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('refund-alloc-branch','refund-alloc-merchant','Main Branch','DMM','active');
INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor,metadata)
VALUES
  ('refund-alloc-order','platform','refund-alloc-customer','refund-alloc-order-key',
   'awaiting_payment','SAR',5000,
   '{"checkoutPricing":{"suborderProductSubtotals":[{"merchantId":"refund-alloc-merchant","branchId":"refund-alloc-branch","amountMinor":5000}]}}'::jsonb);
INSERT INTO merchant_suborders
  (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES
  ('refund-alloc-suborder','platform','refund-alloc-order','refund-alloc-merchant',
   'refund-alloc-branch','confirmed',5000);

INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,status,expires_at)
VALUES
  ('refund-alloc-a','platform','refund-alloc-order','refund-alloc-customer',
   'refund-alloc-key-a','refund-alloc-quote-a','SAR','refund',
   3000,5000,2000,'awaiting_customer_consent',now()+interval '5 minutes'),
  ('refund-alloc-b','platform','refund-alloc-order','refund-alloc-customer',
   'refund-alloc-key-b','refund-alloc-quote-b','SAR','refund',
   1500,5000,3500,'awaiting_customer_consent',now()+interval '5 minutes'),
  ('refund-alloc-c','platform','refund-alloc-order','refund-alloc-customer',
   'refund-alloc-key-c','refund-alloc-quote-c','SAR','refund',
   1000,5000,4000,'awaiting_customer_consent',now()+interval '5 minutes'),
  ('refund-alloc-incomplete','platform','refund-alloc-order','refund-alloc-customer',
   'refund-alloc-key-incomplete','refund-alloc-quote-incomplete','SAR','refund',
   200,5000,4800,'awaiting_customer_consent',now()+interval '5 minutes');

INSERT INTO customer_payment_adjustment_allocations
  (id,tenant_id,adjustment_id,order_id,suborder_id,component_kind,amount_minor,currency)
VALUES
  ('refund-alloc-line-a','platform','refund-alloc-a','refund-alloc-order',
   'refund-alloc-suborder','product_subtotal',3000,'SAR'),
  ('refund-alloc-line-b','platform','refund-alloc-b','refund-alloc-order',
   'refund-alloc-suborder','product_subtotal',1500,'SAR');

UPDATE customer_payment_adjustments
SET status='consented',consented_at=now(),consent_actor_id='refund-alloc-customer',updated_at=now()
WHERE id='refund-alloc-a';

DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM customer_payment_adjustment_allocations
    WHERE adjustment_id='refund-alloc-a' AND amount_minor=3000
  ) THEN
    RAISE EXCEPTION 'refund component allocation was not persisted';
  END IF;

  BEGIN
    UPDATE customer_payment_adjustments
    SET status='consented',consented_at=now(),consent_actor_id='refund-alloc-customer',updated_at=now()
    WHERE id='refund-alloc-incomplete';
    RAISE EXCEPTION 'refund without complete allocation unexpectedly reached consent';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO customer_payment_adjustment_allocations
      (id,tenant_id,adjustment_id,order_id,suborder_id,component_kind,amount_minor,currency)
    VALUES
      ('refund-alloc-line-c-overflow','platform','refund-alloc-c','refund-alloc-order',
       'refund-alloc-suborder','product_subtotal',1000,'SAR');
    RAISE EXCEPTION 'refund allocations exceeded the immutable product source amount';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE customer_payment_adjustment_allocations
    SET amount_minor=1 WHERE id='refund-alloc-line-a';
    RAISE EXCEPTION 'refund allocation unexpectedly mutable';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
END
$test$;

ROLLBACK;
