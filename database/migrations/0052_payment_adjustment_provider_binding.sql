-- Bind each post-checkout adjustment to the exact provider submission that created it.
-- Existing legacy pending adjustments without a provider identity remain unreconcilable
-- until they are explicitly resubmitted through the provider-aware submission flow.
ALTER TABLE customer_payment_adjustments
  ADD COLUMN provider_key text;

ALTER TABLE customer_payment_adjustments
  ADD CONSTRAINT customer_payment_adjustment_provider_key_check
  CHECK (provider_key IS NULL OR provider_key ~ '^[a-zA-Z0-9._-]{1,100}$');

CREATE INDEX customer_payment_adjustments_provider_submission_idx
  ON customer_payment_adjustments (provider_key, provider_reference)
  WHERE status IN ('provider_pending','provider_confirmed');
