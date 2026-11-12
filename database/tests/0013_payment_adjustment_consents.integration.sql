\set ON_ERROR_STOP on
BEGIN;
INSERT INTO customer_orders
  (id, tenant_id, customer_id, idempotency_key, status, currency, total_minor)
VALUES
  ('adjustment-order','platform','adjustment-customer','order-key-0013',
   'confirmed','SAR',10000);

INSERT INTO customer_payment_adjustments
  (id,tenant_id,order_id,customer_id,idempotency_key,quote_reference,currency,
   adjustment_direction,amount_minor,previous_total_minor,proposed_total_minor,
   status,expires_at)
VALUES
  ('adjustment-1','platform','adjustment-order','adjustment-customer',
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
      ('adjustment-invalid','platform','adjustment-order','adjustment-customer',
       'adjustment-key-002','quote-002','SAR','additional_charge',3000,10000,12000,
       'awaiting_customer_consent',now() + interval '5 minutes');
    RAISE EXCEPTION 'inconsistent adjustment amount unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Simulate the guarded lifecycle: consent -> provider pending -> provider-confirmed evidence.
  UPDATE customer_payment_adjustments
    SET status='consented', consented_at=now(), consent_actor_id='adjustment-customer'
    WHERE id='adjustment-1';
  UPDATE customer_payment_adjustments SET status='provider_pending'
    WHERE id='adjustment-1' AND status='consented';
  UPDATE customer_orders SET total_minor=12500, version=version+1
    WHERE id='adjustment-order' AND tenant_id='platform' AND customer_id='adjustment-customer'
      AND total_minor=10000 AND currency='SAR';
  UPDATE customer_payment_adjustments
    SET status='provider_confirmed', provider_reference='provider-confirmed-001',
        provider_confirmed_at=now()
    WHERE id='adjustment-1' AND status='provider_pending';
  IF NOT EXISTS (
    SELECT 1 FROM customer_orders WHERE id='adjustment-order' AND total_minor=12500
  ) THEN RAISE EXCEPTION 'order total was not updated after provider confirmation'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM customer_payment_adjustments
    WHERE id='adjustment-1' AND status='provider_confirmed'
      AND provider_reference='provider-confirmed-001' AND provider_confirmed_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'provider confirmation evidence not persisted'; END IF;

  INSERT INTO customer_payment_adjustment_events
    (id,tenant_id,adjustment_id,actor_id,event_type,occurred_at,snapshot)
  VALUES ('adjustment-event-1','platform','adjustment-1',
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
