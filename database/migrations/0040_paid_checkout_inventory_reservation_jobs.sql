-- Transactional outbox for verified initial captures. The capture worker writes this
-- row in the same transaction as the immutable capture ledger and inbox finalization.
CREATE TABLE paid_checkout_inventory_reservation_jobs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL REFERENCES customer_orders(id) ON DELETE RESTRICT,
  capture_id text NOT NULL UNIQUE REFERENCES verified_order_payment_captures(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','needs_review')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 30),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_id),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
         (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX paid_checkout_inventory_reservation_claim_idx
  ON paid_checkout_inventory_reservation_jobs(status,next_attempt_at,lease_expires_at,created_at)
  WHERE status IN ('pending','processing');

CREATE OR REPLACE FUNCTION protect_paid_checkout_inventory_reservation_job_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.order_id <> OLD.order_id
     OR NEW.capture_id <> OLD.capture_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'paid_checkout_inventory_reservation_job_identity_is_immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paid_checkout_inventory_reservation_job_identity_immutable
BEFORE UPDATE ON paid_checkout_inventory_reservation_jobs
FOR EACH ROW EXECUTE FUNCTION protect_paid_checkout_inventory_reservation_job_identity();

CREATE OR REPLACE FUNCTION reject_paid_checkout_inventory_reservation_job_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'paid_checkout_inventory_reservation_jobs_cannot_be_truncated'
    USING ERRCODE='55000';
END $$;
CREATE TRIGGER paid_checkout_inventory_reservation_job_no_truncate
BEFORE TRUNCATE ON paid_checkout_inventory_reservation_jobs
FOR EACH STATEMENT EXECUTE FUNCTION reject_paid_checkout_inventory_reservation_job_truncate();
