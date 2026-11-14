-- Keep malformed evidence distinct from valid evidence scoped to another order.
-- 0046 originally grouped both cases under SQLSTATE 23503; callers and tests
-- should be able to distinguish data-shape violations from referential violations.
CREATE OR REPLACE FUNCTION ensure_checkout_recovery_reservation_suborders_belong_to_order()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF jsonb_typeof(NEW.reservation_references) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'checkout_recovery_reservation_references_must_be_array'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.reservation_references) AS evidence(value)
    WHERE jsonb_typeof(evidence.value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(evidence.value->'suborderId') IS DISTINCT FROM 'string'
       OR COALESCE(length(trim(evidence.value->>'suborderId')), 0) NOT BETWEEN 1 AND 200
       OR jsonb_typeof(evidence.value->'reservationReference') IS DISTINCT FROM 'string'
       OR COALESCE(length(trim(evidence.value->>'reservationReference')), 0) NOT BETWEEN 1 AND 240
  ) THEN
    RAISE EXCEPTION 'checkout_recovery_reservation_evidence_shape_violation'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.reservation_references) AS evidence(value)
    WHERE NOT EXISTS (
      SELECT 1 FROM merchant_suborders suborder
      WHERE suborder.order_id = NEW.order_id
        AND suborder.id = evidence.value->>'suborderId'
    )
  ) THEN
    RAISE EXCEPTION 'checkout_recovery_reservation_suborder_scope_violation'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$function$;
