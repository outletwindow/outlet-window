-- Durable customer cart ownership and branch-scoped catalog variant lines.
CREATE TABLE customer_carts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','abandoned')),
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX customer_carts_one_active_per_customer
  ON customer_carts (tenant_id, customer_id) WHERE status = 'active';
CREATE INDEX customer_carts_customer_updated_idx
  ON customer_carts (customer_id, updated_at DESC);

CREATE TABLE customer_cart_items (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  cart_id text NOT NULL,
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  product_variant_id text NOT NULL REFERENCES commerce_catalog_variants(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, cart_id) REFERENCES customer_carts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (merchant_id, branch_id) REFERENCES merchant_branches (merchant_id, id) ON DELETE RESTRICT,
  UNIQUE (cart_id, merchant_id, branch_id, product_variant_id)
);
CREATE INDEX customer_cart_items_cart_idx ON customer_cart_items (tenant_id, cart_id, created_at, id);
