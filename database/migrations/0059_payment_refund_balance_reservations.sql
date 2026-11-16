-- Reserve the refundable balance of each verified original capture before a refund
-- outbox row can be committed. The capture row lock serializes competing refunds.
CREATE TABLE payment_refund_reservations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  adjustment_id text NOT NULL,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-zA-Z0-9._-]{1,100}$'),
  original_payment_reference text NOT NULL CHECK (length(trim(original_payment_reference)) BETWEEN 1 AND 240),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved','confirmed','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, adjustment_id),
  FOREIGN KEY (tenant_id, adjustment_id)
    REFERENCES customer_payment_adjustments(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX payment_refund_reservations_capture_idx
  ON payment_refund_reservations(tenant_id,provider_key,original_payment_reference)
  WHERE status <> 'released';
-- Moyasar moves a successfully partially refunded payment to "refunded"; its
-- refund endpoint accepts only paid/captured states. Permit one active refund
-- operation per original payment until a definitive rejection releases it.
CREATE UNIQUE INDEX payment_refund_reservations_one_active_per_capture_idx
  ON payment_refund_reservations(tenant_id,provider_key,original_payment_reference)
  WHERE status <> 'released';

-- Existing jobs are included in the reserved balance. A failed provider rejection
-- is released; submitted, queued and ambiguous jobs continue consuming capacity.
DO $backfill_check$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT o.tenant_id,o.provider_key,o.original_payment_reference,
             SUM(a.amount_minor) AS reserved_minor,
             COUNT(*) AS active_refunds,
             MAX(c.amount_minor) AS captured_minor
      FROM payment_adjustment_submission_outbox o
      JOIN customer_payment_adjustments a
        ON a.tenant_id=o.tenant_id AND a.id=o.adjustment_id
      JOIN verified_order_payment_captures c
        ON c.tenant_id=a.tenant_id AND c.order_id=a.order_id
       AND c.provider_key=o.provider_key
       AND c.provider_payment_reference=o.original_payment_reference
      WHERE a.adjustment_direction='refund'
        AND o.original_payment_reference IS NOT NULL
        AND o.status <> 'failed'
      GROUP BY o.tenant_id,o.provider_key,o.original_payment_reference
    ) totals
    WHERE reserved_minor > captured_minor OR active_refunds > 1
  ) THEN
    RAISE EXCEPTION 'existing_refund_submissions_exceed_verified_capture_balance';
  END IF;
END
$backfill_check$;

INSERT INTO payment_refund_reservations
  (id,tenant_id,adjustment_id,provider_key,original_payment_reference,
   amount_minor,currency,status,created_at,updated_at)
SELECT 'legacy-refund-' || md5(o.tenant_id || ':' || o.adjustment_id),
       o.tenant_id,o.adjustment_id,o.provider_key,o.original_payment_reference,
       a.amount_minor,a.currency,
       CASE WHEN o.status='failed' THEN 'released' ELSE 'reserved' END,
       o.created_at,now()
FROM payment_adjustment_submission_outbox o
JOIN customer_payment_adjustments a
  ON a.tenant_id=o.tenant_id AND a.id=o.adjustment_id
WHERE a.adjustment_direction='refund'
  AND o.original_payment_reference IS NOT NULL
ON CONFLICT (tenant_id,adjustment_id) DO NOTHING;

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

  IF EXISTS (
    SELECT 1 FROM payment_refund_reservations
    WHERE tenant_id=NEW.tenant_id AND provider_key=NEW.provider_key
      AND original_payment_reference=v_reference AND status <> 'released'
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

CREATE TRIGGER payment_adjustment_refund_reservation_after_insert
AFTER INSERT ON payment_adjustment_submission_outbox
FOR EACH ROW EXECUTE FUNCTION reserve_payment_adjustment_refund();

CREATE OR REPLACE FUNCTION sync_payment_refund_reservation_terminal_status()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.status='provider_pending' AND NEW.status='provider_confirmed' THEN
    UPDATE payment_refund_reservations
      SET status='confirmed',updated_at=now()
    WHERE tenant_id=NEW.tenant_id AND adjustment_id=NEW.id AND status='reserved';
  ELSIF OLD.status='provider_pending' AND NEW.status='provider_failed' THEN
    UPDATE payment_refund_reservations
      SET status='released',updated_at=now()
    WHERE tenant_id=NEW.tenant_id AND adjustment_id=NEW.id AND status='reserved';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER customer_payment_adjustment_refund_reservation_terminal
AFTER UPDATE OF status ON customer_payment_adjustments
FOR EACH ROW EXECUTE FUNCTION sync_payment_refund_reservation_terminal_status();

-- Reject direct mutation of reservation identity, amount, capture binding or history.
CREATE OR REPLACE FUNCTION guard_payment_refund_reservation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'payment_refund_reservations_are_immutable'
      USING ERRCODE='23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.adjustment_id IS DISTINCT FROM OLD.adjustment_id
     OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.original_payment_reference IS DISTINCT FROM OLD.original_payment_reference
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment_refund_reservation_identity_is_immutable'
      USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT
     ((OLD.status='reserved' AND NEW.status IN ('confirmed','released'))) THEN
    RAISE EXCEPTION 'payment_refund_reservation_transition_invalid'
      USING ERRCODE='23514';
  END IF;
  IF NEW.status='confirmed' AND NOT EXISTS (
    SELECT 1 FROM customer_payment_adjustments
    WHERE tenant_id=OLD.tenant_id AND id=OLD.adjustment_id
      AND status='provider_confirmed'
  ) THEN
    RAISE EXCEPTION 'refund_reservation_confirmation_requires_confirmed_adjustment'
      USING ERRCODE='23514';
  END IF;
  IF NEW.status='released' AND NOT EXISTS (
    SELECT 1 FROM customer_payment_adjustments
    WHERE tenant_id=OLD.tenant_id AND id=OLD.adjustment_id
      AND status='provider_failed'
  ) THEN
    RAISE EXCEPTION 'refund_reservation_release_requires_definitive_provider_failure'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER payment_refund_reservation_guard
BEFORE UPDATE OR DELETE ON payment_refund_reservations
FOR EACH ROW EXECUTE FUNCTION guard_payment_refund_reservation();
