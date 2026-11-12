-- Durable scheduled fulfillment outbox. Payloads contain task instructions only; never credentials or payment secrets.
CREATE TABLE IF NOT EXISTS scheduled_task_outbox (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 240),
  task_type text NOT NULL CHECK (task_type IN ('merchant_reservation','merchant_preparation','courier_dispatch','shopper_collection')),
  execute_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','leased','published','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  lease_token text,
  lease_expires_at timestamptz,
  published_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  FOREIGN KEY (tenant_id, order_id) REFERENCES customer_orders(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status = 'published') = (published_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS scheduled_task_outbox_due_idx
  ON scheduled_task_outbox (available_at, execute_at, created_at, id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS scheduled_task_outbox_expired_lease_idx
  ON scheduled_task_outbox (lease_expires_at, id)
  WHERE status = 'leased';
CREATE INDEX IF NOT EXISTS scheduled_task_outbox_tenant_order_idx
  ON scheduled_task_outbox (tenant_id, order_id, created_at, id);
CREATE INDEX IF NOT EXISTS scheduled_task_outbox_dead_letter_idx
  ON scheduled_task_outbox (updated_at DESC, id)
  WHERE status = 'dead_letter';

-- Durable evidence that an external payment capture was confirmed before scheduled order commit.
CREATE TABLE IF NOT EXISTS scheduled_order_confirmations (
  order_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  payment_reference text NOT NULL UNIQUE CHECK (length(trim(payment_reference)) BETWEEN 1 AND 240),
  payment_captured_at timestamptz NOT NULL,
  confirmed_at timestamptz NOT NULL,
  fulfillment_version integer NOT NULL CHECK (fulfillment_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES customer_orders(tenant_id, id) ON DELETE RESTRICT,
  CHECK (confirmed_at >= payment_captured_at),
  UNIQUE (tenant_id, order_id)
);

-- Durable internal inbox makes the outbox handoff idempotent across worker crashes.
CREATE TABLE IF NOT EXISTS scheduled_task_inbox (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 240),
  task_type text NOT NULL CHECK (task_type IN ('merchant_reservation','merchant_preparation','courier_dispatch','shopper_collection')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  FOREIGN KEY (tenant_id, order_id) REFERENCES customer_orders(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'completed') = (processed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS scheduled_task_inbox_pending_idx
  ON scheduled_task_inbox (created_at, id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS scheduled_task_inbox_tenant_order_idx
  ON scheduled_task_inbox (tenant_id, order_id, created_at, id);
