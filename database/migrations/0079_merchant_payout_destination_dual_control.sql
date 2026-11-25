-- Destination ownership and independent verification controls.
-- vault_reference remains an opaque pointer; raw bank details never enter this table.
ALTER TABLE merchant_payout_destinations
  ADD COLUMN created_by text;

CREATE INDEX merchant_payout_destinations_pending_review_idx
  ON merchant_payout_destinations(created_at,id)
  WHERE verification_status='pending';

CREATE OR REPLACE FUNCTION enforce_merchant_payout_destination_dual_control()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.created_by IS NULL OR length(trim(NEW.created_by)) NOT BETWEEN 1 AND 160 THEN
      RAISE EXCEPTION 'merchant_payout_destination_creator_required'
        USING ERRCODE='23514';
    END IF;
    IF NEW.verification_status <> 'pending'
      OR NEW.verified_by IS NOT NULL OR NEW.verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'merchant_payout_destination_must_start_pending'
        USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'merchant_payout_destination_creator_is_immutable'
        USING ERRCODE='55000';
    END IF;
    IF OLD.verification_status='pending' AND NEW.verification_status='verified' THEN
      IF NEW.created_by IS NULL OR NEW.verified_by IS NULL
        OR NEW.verified_by=NEW.created_by OR NEW.verified_at IS NULL THEN
        RAISE EXCEPTION 'merchant_payout_destination_independent_approval_required'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF NEW.verification_status='revoked' AND NEW.verified_by IS DISTINCT FROM OLD.verified_by THEN
      RAISE EXCEPTION 'merchant_payout_destination_revocation_cannot_rewrite_approver'
        USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER merchant_payout_destination_dual_control
BEFORE INSERT OR UPDATE ON merchant_payout_destinations
FOR EACH ROW EXECUTE FUNCTION enforce_merchant_payout_destination_dual_control();

-- Legacy destinations without creator attribution remain historical only.
-- They cannot be approved or submitted; replacement registration is required.
