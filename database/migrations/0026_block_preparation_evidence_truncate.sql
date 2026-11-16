-- Row-level UPDATE/DELETE triggers do not fire for TRUNCATE.
-- Block bulk removal of immutable preparation evidence as well.
CREATE OR REPLACE FUNCTION reject_preparation_check_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'merchant_order_item_preparation_checks_are_immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER merchant_order_item_preparation_checks_no_truncate
BEFORE TRUNCATE ON merchant_order_item_preparation_checks
FOR EACH STATEMENT
EXECUTE FUNCTION reject_preparation_check_truncate();
