-- Preparation checks are evidence records. Corrections require a new governed workflow,
-- never mutation or deletion of the original observation.
CREATE OR REPLACE FUNCTION reject_preparation_check_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'merchant_order_item_preparation_checks_are_immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER merchant_order_item_preparation_checks_immutable
BEFORE UPDATE OR DELETE ON merchant_order_item_preparation_checks
FOR EACH ROW EXECUTE FUNCTION reject_preparation_check_mutation();
