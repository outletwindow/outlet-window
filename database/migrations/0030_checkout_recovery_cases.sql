-- Durable recovery queue for paid multi-store checkout failures.
-- Cases require an explicit refund/customer-resolution workflow; this table never issues refunds.
CREATE TABLE checkout_recovery_cases (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  failure_code text NOT NULL CHECK (failure_code IN ('INVENTORY_UNAVAILABLE','INVENTORY_UNGUARANTEED','TASK_COMMIT_REJECTED')),
  failed_suborder_id text,
  payment_reference text NOT NULL CHECK (length(trim(payment_reference)) BETWEEN 1 AND 240),
  payment_captured_at timestamptz NOT NULL,
  reservation_references jsonb NOT NULL CHECK (jsonb_typeof(reservation_references) = 'array'),
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','resolved','cancelled')),
  resolution_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((status = 'resolved' AND resolved_at IS NOT NULL AND resolution_code IS NOT NULL) OR
         (status <> 'resolved' AND resolved_at IS NULL))
);
CREATE INDEX checkout_recovery_cases_pending_idx
  ON checkout_recovery_cases(created_at,id) WHERE status = 'pending_review';
