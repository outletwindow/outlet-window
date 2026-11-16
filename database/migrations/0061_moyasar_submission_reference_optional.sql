-- Moyasar's refund endpoint returns a payment snapshot, not a distinct refund-operation reference.
-- The durable submitted outbox state is the acceptance evidence; the original capture
-- reference remains on the refund reservation and webhook receipt.
DO $migration$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid='payment_adjustment_submission_outbox'::regclass
      AND contype='c'
      AND pg_get_constraintdef(oid) ILIKE '%provider_reference%'
      AND pg_get_constraintdef(oid) ILIKE '%completed_at%'
  LOOP
    EXECUTE format(
      'ALTER TABLE payment_adjustment_submission_outbox DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END
$migration$;

ALTER TABLE payment_adjustment_submission_outbox
  ADD CONSTRAINT payment_adjustment_submission_outbox_submitted_reference_check
  CHECK (
    (status='submitted' AND completed_at IS NOT NULL
      AND (provider_reference IS NOT NULL OR provider_key='moyasar'))
    OR (status<>'submitted' AND completed_at IS NULL)
  );

-- A missing provider operation reference is valid only for a Moyasar refund
-- backed by the exact original captured payment. Moyasar additional charges
-- and every other provider must retain a concrete provider reference.
CREATE OR REPLACE FUNCTION enforce_moyasar_reference_exception()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  v_adjustment_direction text;
BEGIN
  IF NEW.status='submitted' AND NEW.provider_reference IS NULL THEN
    SELECT a.adjustment_direction
      INTO v_adjustment_direction
      FROM customer_payment_adjustments AS a
      WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.adjustment_id
      FOR KEY SHARE;

    IF NEW.provider_key <> 'moyasar'
       OR v_adjustment_direction IS DISTINCT FROM 'refund'
       OR NEW.original_payment_reference IS NULL THEN
      RAISE EXCEPTION 'missing_provider_reference_allowed_only_for_bound_moyasar_refunds'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS payment_adjustment_moyasar_reference_exception
  ON payment_adjustment_submission_outbox;
CREATE TRIGGER payment_adjustment_moyasar_reference_exception
BEFORE INSERT OR UPDATE ON payment_adjustment_submission_outbox
FOR EACH ROW EXECUTE FUNCTION enforce_moyasar_reference_exception();
