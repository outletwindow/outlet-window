-- Reservation evidence in a recovery case may reference only suborders of that same parent order.
CREATE OR REPLACE FUNCTION ensure_checkout_recovery_reservation_suborders_belong_to_order()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF jsonb_typeof(NEW.reservation_references) = 'array' AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.reservation_references) AS evidence(value)
    WHERE jsonb_typeof(evidence.value) <> 'object'
       OR jsonb_typeof(evidence.value->'suborderId') <> 'string'
       OR length(trim(evidence.value->>'suborderId')) = 0
       OR NOT EXISTS (
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

CREATE TRIGGER checkout_recovery_reservation_suborder_scope
BEFORE INSERT OR UPDATE OF order_id, reservation_references
ON checkout_recovery_cases
FOR EACH ROW
EXECUTE FUNCTION ensure_checkout_recovery_reservation_suborders_belong_to_order();
