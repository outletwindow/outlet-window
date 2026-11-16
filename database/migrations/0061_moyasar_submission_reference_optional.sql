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
