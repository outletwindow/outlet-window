BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'merchant_order_item_preparation_checks'::regclass
      AND tgname = 'merchant_order_item_preparation_checks_immutable'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'preparation evidence immutability trigger is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'reject_preparation_check_mutation'
      AND pg_get_functiondef(oid) LIKE '%merchant_order_item_preparation_checks_are_immutable%'
  ) THEN
    RAISE EXCEPTION 'preparation evidence mutation guard is missing';
  END IF;
END $$;
ROLLBACK;
