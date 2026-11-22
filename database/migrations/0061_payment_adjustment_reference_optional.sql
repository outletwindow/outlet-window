-- Some PSPs (including Moyasar refunds) return only the original payment
-- snapshot and do not issue a distinct refund-operation reference. The durable
-- outbox and reservation are the operation identity in that case.
DO $migration$
DECLARE
  constraint_to_drop text;
BEGIN
  SELECT conname INTO constraint_to_drop
  FROM pg_constraint
  WHERE conrelid='payment_adjustment_submission_outbox'::regclass
    AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%provider_reference IS NOT NULL%'
  LIMIT 1;

  IF constraint_to_drop IS NULL THEN
    RAISE EXCEPTION 'payment_adjustment_submitted_reference_constraint_not_found';
  END IF;

  EXECUTE format(
    'ALTER TABLE payment_adjustment_submission_outbox DROP CONSTRAINT %I',
    constraint_to_drop
  );
END
$migration$;

ALTER TABLE payment_adjustment_submission_outbox
  ADD CONSTRAINT payment_adjustment_submission_outbox_completion_check
  CHECK (
    (status='submitted' AND completed_at IS NOT NULL)
    OR (status<>'submitted' AND completed_at IS NULL)
  );
