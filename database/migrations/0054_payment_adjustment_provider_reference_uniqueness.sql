-- A provider submission reference identifies one financial adjustment within a tenant.
-- Reusing it would allow one provider operation to be ambiguously associated with
-- multiple adjustment records during webhook reconciliation.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM customer_payment_adjustments
    WHERE provider_reference IS NOT NULL
    GROUP BY tenant_id, provider_key, provider_reference
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate_payment_adjustment_provider_reference_exists';
  END IF;
END
$migration$;

CREATE UNIQUE INDEX customer_payment_adjustments_provider_reference_once_idx
  ON customer_payment_adjustments (tenant_id, provider_key, provider_reference)
  WHERE provider_reference IS NOT NULL;
