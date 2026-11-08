\set ON_ERROR_STOP on
BEGIN;
INSERT INTO customer_orders
  (id, tenant_id, customer_id, idempotency_key, status, currency, total_minor)
VALUES
  ('adjustment-order','adjustment-tenant','adjustment-customer','order-key-0013',
   'confirmed','SAR',10000);

INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
   status,expires_at)
VALUES
  ('adjustment-1','adjustment-tenant','adjustment-order','adjustment-customer',
   'adjustment-key-001','quote-001','SAR','additional_charge',2500,10000,12500,
   'awaiting_customer_consent',now() + interval '5 minutes');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM customer_payment_adjustments
    WHERE id='adjustment-1' AND amount_minor=2500
      AND status='awaiting_customer_consent'
  ) THEN RAISE EXCEPTION 'payment adjustment intent not persisted'; END IF;

  BEGIN
    INSERT INTO customer_payment_adjustments
      (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
       adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
       status,expires_at)
    VALUES
      ('adjustment-invalid','adjustment-tenant','adjustment-order','adjustment-customer',
       'adjustment-key-002','quote-002','SAR','additional_charge',3000,10000,12000,
       'awaiting_customer_consent',now() + interval '5 minutes');
    RAISE EXCEPTION 'inconsistent adjustment amount unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  INSERT INTO customer_payment_adjustment_events
    (id,tenant_id,adjustment_id,actor_id,event_type,occurred_at,snapshot)
  VALUES ('adjustment-event-1','adjustment-tenant','adjustment-1',
    'adjustment-customer','created',now(),'{"status":"awaiting_customer_consent"}'::jsonb);

  BEGIN
    UPDATE customer_payment_adjustment_events
      SET actor_id='tampered' WHERE id='adjustment-event-1';
    RAISE EXCEPTION 'append-only adjustment event unexpectedly mutable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'customer_payment_adjustment_events_are_append_only' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
