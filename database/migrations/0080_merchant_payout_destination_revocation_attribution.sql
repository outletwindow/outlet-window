-- Record who revoked a payout destination and make revocation terminal.
ALTER TABLE merchant_payout_destinations ADD COLUMN revoked_by text, ADD COLUMN revoked_at timestamptz;
CREATE OR REPLACE FUNCTION enforce_merchant_payout_destination_dual_control() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.created_by IS NULL OR length(trim(NEW.created_by)) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'merchant_payout_destination_creator_required' USING ERRCODE='23514'; END IF;
  IF NEW.verification_status <> 'pending' OR NEW.verified_by IS NOT NULL OR NEW.verified_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'merchant_payout_destination_must_start_pending' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN RAISE EXCEPTION 'merchant_payout_destination_creator_is_immutable' USING ERRCODE='55000'; END IF;
  IF OLD.verification_status='revoked' THEN RAISE EXCEPTION 'merchant_payout_destination_revocation_is_terminal' USING ERRCODE='55000'; END IF;
  IF OLD.verification_status='pending' AND NEW.verification_status='verified' AND (NEW.created_by IS NULL OR NEW.verified_by IS NULL OR NEW.verified_by=NEW.created_by OR NEW.verified_at IS NULL) THEN RAISE EXCEPTION 'merchant_payout_destination_independent_approval_required' USING ERRCODE='23514'; END IF;
  IF NEW.verification_status='revoked' AND OLD.verification_status<>'revoked' THEN
   IF NEW.revoked_by IS NULL OR length(trim(NEW.revoked_by)) NOT BETWEEN 1 AND 160 OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'merchant_payout_destination_revocation_attribution_required' USING ERRCODE='23514'; END IF;
   IF NEW.verified_by IS DISTINCT FROM OLD.verified_by OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN RAISE EXCEPTION 'merchant_payout_destination_revocation_cannot_rewrite_approval' USING ERRCODE='55000'; END IF;
  ELSIF NEW.revoked_by IS DISTINCT FROM OLD.revoked_by OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN RAISE EXCEPTION 'merchant_payout_destination_revocation_attribution_is_immutable' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END
$$;
