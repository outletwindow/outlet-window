\set ON_ERROR_STOP on
BEGIN;
DO $checks$
DECLARE
  required_tables text[] := ARRAY[
    'merchant_payout_destinations',
    'merchant_payout_provider_outbox',
    'merchant_payout_provider_events'
  ];
  missing text;
BEGIN
  SELECT name INTO missing
  FROM unnest(required_tables) AS name
  WHERE to_regclass('public.' || name) IS NULL
  LIMIT 1;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'missing payout provider table: %',missing; END IF;

  IF to_regprocedure('public.enqueue_merchant_payout_provider_submission(text,text,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'payout provider enqueue function missing';
  END IF;
  IF has_function_privilege('public','public.enqueue_merchant_payout_provider_submission(text,text,text,text,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'payout enqueue function must not be executable by PUBLIC';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='merchant_payout_destinations'
      AND column_name IN ('iban','account_number','bank_account_number','raw_credentials')
  ) THEN RAISE EXCEPTION 'raw payout destination data column must not exist'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.merchant_payout_provider_outbox'::regclass
      AND tgname='merchant_payout_provider_outbox_guard' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'payout outbox immutable transition guard missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='merchant_payout_provider_outbox'
      AND indexname='merchant_payout_provider_outbox_due_idx'
  ) THEN RAISE EXCEPTION 'payout outbox due index missing'; END IF;
END
$checks$;
ROLLBACK;
