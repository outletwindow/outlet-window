\set ON_ERROR_STOP on
BEGIN;

INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES ('ci-handover-merchant','Handover Merchant LLC','Handover Merchant','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('ci-handover-branch','ci-handover-merchant','Handover Branch','DMM','active');
INSERT INTO customer_orders
  (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('ci-handover-order','platform','ci-handover-customer','ci-handover-order-idem',
  'awaiting_payment','SAR',20000);
INSERT INTO merchant_suborders
  (id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('ci-handover-suborder','ci-handover-merchant','ci-handover-order',
  'ci-handover-merchant','ci-handover-branch','awaiting_payment',20000);

INSERT INTO inventory_reservations
  (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,idempotency_key,
   status,requested_at,handover_reference)
VALUES ('ci-handover-reservation-a','ci-handover-merchant','ci-handover-order',
  'ci-handover-suborder','ci-handover-merchant','ci-handover-branch',
  'ci-handover-reservation-a-v1','consumed',now(),'provider:handover-123');

DO $$
BEGIN
  BEGIN
    INSERT INTO inventory_reservations
      (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,idempotency_key,
       status,requested_at,handover_reference)
    VALUES ('ci-handover-reservation-b','ci-handover-merchant','ci-handover-order',
      'ci-handover-suborder','ci-handover-merchant','ci-handover-branch',
      'ci-handover-reservation-b-v1','consumed',now(),'provider:handover-123');
    RAISE EXCEPTION 'duplicate handover evidence unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  IF EXISTS (
    SELECT 1 FROM inventory_reservations
    WHERE id = 'ci-handover-reservation-b'
  ) THEN
    RAISE EXCEPTION 'duplicate handover evidence created a second consumed reservation';
  END IF;
END $$;

ROLLBACK;
