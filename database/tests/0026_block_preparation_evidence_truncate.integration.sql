BEGIN;
DO $$
DECLARE
  trigger_bits integer;
BEGIN
  SELECT tgtype INTO trigger_bits
  FROM pg_trigger
  WHERE tgrelid = 'merchant_order_item_preparation_checks'::regclass
    AND tgname = 'merchant_order_item_preparation_checks_no_truncate'
    AND NOT tgisinternal;

  IF trigger_bits IS NULL OR (trigger_bits & 32) = 0 THEN
    RAISE EXCEPTION 'preparation evidence TRUNCATE guard is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'reject_preparation_check_truncate'
      AND pg_get_functiondef(oid) LIKE '%merchant_order_item_preparation_checks_are_immutable%'
  ) THEN
    RAISE EXCEPTION 'preparation evidence TRUNCATE rejection function is missing';
  END IF;
END $$;
ROLLBACK;
