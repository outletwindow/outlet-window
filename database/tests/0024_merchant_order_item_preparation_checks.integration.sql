BEGIN;
DO $$
DECLARE
  required_constraints integer;
BEGIN
  SELECT COUNT(*) INTO required_constraints
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'merchant_order_item_preparation_checks'
    AND c.contype IN ('f','u','c');
  IF required_constraints < 8 THEN
    RAISE EXCEPTION 'preparation check table is missing required foreign key, uniqueness, or validation constraints';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'merchant_order_item_preparation_checks'
      AND indexname = 'merchant_order_item_preparation_checks_branch_idx'
  ) THEN
    RAISE EXCEPTION 'branch-scoped preparation check index is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'customer_order_items'::regclass
      AND conname = 'customer_order_items_tenant_suborder_item_key'
      AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'composite item ownership key is missing';
  END IF;
END $$;
ROLLBACK;
