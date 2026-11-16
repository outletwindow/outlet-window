CREATE TABLE IF NOT EXISTS customer_orders (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  customer_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 200),
  status text NOT NULL CHECK (status IN ('draft','pending_validation','awaiting_payment','confirmed','merchant_acceptance_pending','preparing','ready_for_pickup','pickup_in_progress','in_transit','out_for_delivery','delivered','completed','on_hold','stock_unavailable','payment_failed','merchant_rejected','delivery_failed','cancellation_requested','cancelled','return_requested','return_in_progress','returned','refund_pending','refunded','disputed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, customer_id, idempotency_key),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS customer_orders_tenant_created_idx
  ON customer_orders (tenant_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS customer_orders_customer_created_idx
  ON customer_orders (tenant_id, customer_id, created_at DESC);
CREATE TABLE IF NOT EXISTS merchant_suborders (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','pending_validation','awaiting_payment','confirmed','merchant_acceptance_pending','preparing','ready_for_pickup','pickup_in_progress','in_transit','out_for_delivery','delivered','completed','on_hold','stock_unavailable','payment_failed','merchant_rejected','delivery_failed','cancellation_requested','cancelled','return_requested','return_in_progress','returned','refund_pending','refunded','disputed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES customer_orders(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, branch_id) REFERENCES merchant_branches(merchant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, order_id, id)
);
CREATE INDEX IF NOT EXISTS merchant_suborders_tenant_order_idx
  ON merchant_suborders (tenant_id, order_id, created_at, id);
CREATE INDEX IF NOT EXISTS merchant_suborders_merchant_status_idx
  ON merchant_suborders (merchant_id, status, created_at DESC);
