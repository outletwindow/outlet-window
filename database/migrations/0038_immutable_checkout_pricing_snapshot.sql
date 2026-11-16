-- Once a checkout pricing snapshot is written with the order, it is immutable.
-- The snapshot must be supplied on the initial order INSERT; later writes cannot add,
-- remove, or rewrite it. Unrelated operational metadata may still evolve.
CREATE OR REPLACE FUNCTION prevent_customer_order_checkout_pricing_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (OLD.metadata ? 'checkoutPricing' OR NEW.metadata ? 'checkoutPricing')
     AND OLD.metadata->'checkoutPricing' IS DISTINCT FROM NEW.metadata->'checkoutPricing' THEN
    RAISE EXCEPTION 'checkout_pricing_snapshot_immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_orders_checkout_pricing_immutable
BEFORE UPDATE OF metadata ON customer_orders
FOR EACH ROW
EXECUTE FUNCTION prevent_customer_order_checkout_pricing_mutation();
