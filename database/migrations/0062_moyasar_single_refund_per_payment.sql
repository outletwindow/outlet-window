-- Moyasar accepts refunds only while a payment is paid/captured. A successful
-- partial or full refund changes the payment status to refunded, so a second
-- refund operation against that same payment cannot be submitted.
-- This restriction is provider-specific; other PSP adapters retain their own
-- documented refund lifecycle and may support multiple partial refund operations.
-- Re-check after locking the original capture to serialize against webhook
-- confirmation and concurrent refund reservations.
CREATE OR REPLACE FUNCTION reserve_payment_adjustment_refund()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  v_direction text;
  v_order_id text;
  v_amount bigint;
  v_currency char(3);
  v_reference text;
  v_capture_amount bigint;
  v_capture_currency char(3);
  v_reserved bigint;
BEGIN
  SELECT adjustment_direction,order_id,amount_minor,currency
    INTO v_direction,v_order_id,v_amount,v_currency
  FROM customer_payment_adjustments
  WHERE tenant_id=NEW.tenant_id AND id=NEW.adjustment_id
  FOR KEY SHARE;

  IF NOT FOUND OR v_direction <> 'refund' THEN
    RETURN NEW;
  END IF;

  SELECT provider_payment_reference,amount_minor,currency
    INTO v_reference,v_capture_amount,v_capture_currency
  FROM verified_order_payment_captures
  WHERE tenant_id=NEW.tenant_id AND order_id=v_order_id
    AND provider_key=NEW.provider_key
  FOR UPDATE;

  IF NOT FOUND OR v_reference IS NULL
     OR NEW.original_payment_reference IS DISTINCT FROM v_reference
     OR v_currency <> v_capture_currency THEN
    RAISE EXCEPTION 'refund_reservation_requires_exact_verified_capture'
      USING ERRCODE='23514';
  END IF;

  IF NEW.provider_key='moyasar' AND EXISTS (
    SELECT 1 FROM payment_refund_reservations
    WHERE tenant_id=NEW.tenant_id AND provider_key=NEW.provider_key
      AND original_payment_reference=v_reference AND status='confirmed'
  ) THEN
    RAISE EXCEPTION 'moyasar_payment_already_refunded_once'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM payment_refund_reservations
    WHERE tenant_id=NEW.tenant_id AND provider_key=NEW.provider_key
      AND original_payment_reference=v_reference AND status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'original_payment_already_has_active_refund_operation'
      USING ERRCODE='23514';
  END IF;

  SELECT COALESCE(SUM(amount_minor),0) INTO v_reserved
  FROM payment_refund_reservations
  WHERE tenant_id=NEW.tenant_id AND provider_key=NEW.provider_key
    AND original_payment_reference=v_reference AND status <> 'released';

  IF v_reserved + v_amount > v_capture_amount THEN
    RAISE EXCEPTION 'refund_reservation_exceeds_remaining_original_capture'
      USING ERRCODE='23514';
  END IF;

  INSERT INTO payment_refund_reservations
    (id,tenant_id,adjustment_id,provider_key,original_payment_reference,
     amount_minor,currency,status,created_at,updated_at)
  VALUES
    ('refund-reservation-' || NEW.id,NEW.tenant_id,NEW.adjustment_id,
     NEW.provider_key,v_reference,v_amount,v_currency,'reserved',now(),now());

  RETURN NEW;
END
$function$;
