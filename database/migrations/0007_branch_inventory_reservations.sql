-- Branch-level inventory, order lines, and atomic reservation ledger.
-- Stock is merchant-owned; customer orders remain platform-owned.
CREATE TABLE IF NOT EXISTS customer_order_items (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL REFERENCES customer_orders(id) ON DELETE RESTRICT,
  suborder_id text NOT NULL,
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  product_variant_id text NOT NULL CHECK (length(trim(product_variant_id)) BETWEEN 1 AND 200),
  sku text NOT NULL CHECK (length(trim(sku)) BETWEEN 1 AND 120),
  size_label text,
  color_label text,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id, suborder_id)
    REFERENCES merchant_suborders(tenant_id, order_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES merchants(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, branch_id)
    REFERENCES merchant_branches(merchant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, suborder_id, product_variant_id)
);
CREATE INDEX IF NOT EXISTS customer_order_items_order_idx
  ON customer_order_items (order_id, tenant_id, suborder_id);

CREATE TABLE IF NOT EXISTS branch_inventory (
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  product_variant_id text NOT NULL CHECK (length(trim(product_variant_id)) BETWEEN 1 AND 200),
  sku text NOT NULL CHECK (length(trim(sku)) BETWEEN 1 AND 120),
  available_quantity integer NOT NULL CHECK (available_quantity >= 0),
  reserved_quantity integer NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  source text NOT NULL CHECK (source IN ('pos','erp','ecommerce','csv','merchant_portal','manual')),
  last_synced_at timestamptz NOT NULL,
  availability_confidence text NOT NULL CHECK (availability_confidence IN ('high','medium','low','unknown')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, branch_id, product_variant_id),
  FOREIGN KEY (merchant_id, branch_id)
    REFERENCES merchant_branches(merchant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS branch_inventory_freshness_idx
  ON branch_inventory (merchant_id, branch_id, last_synced_at DESC);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL REFERENCES customer_orders(id) ON DELETE RESTRICT,
  suborder_id text NOT NULL,
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 240),
  status text NOT NULL CHECK (status IN ('reserved','released','expired','consumed')),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id, suborder_id)
    REFERENCES merchant_suborders(tenant_id, order_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES merchants(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, branch_id)
    REFERENCES merchant_branches(merchant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  CHECK (expires_at IS NULL OR expires_at > requested_at)
);
CREATE INDEX IF NOT EXISTS inventory_reservations_order_idx
  ON inventory_reservations (tenant_id, order_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_reservations_expiry_idx
  ON inventory_reservations (expires_at, id) WHERE status = 'reserved';

CREATE TABLE IF NOT EXISTS inventory_reservation_lines (
  reservation_id text NOT NULL REFERENCES inventory_reservations(id) ON DELETE RESTRICT,
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  product_variant_id text NOT NULL,
  sku text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (reservation_id, product_variant_id),
  FOREIGN KEY (merchant_id, branch_id, product_variant_id)
    REFERENCES branch_inventory(merchant_id, branch_id, product_variant_id) ON DELETE RESTRICT
);
