-- Durable, branch-scoped item verification performed during merchant preparation.
ALTER TABLE customer_order_items
  ADD CONSTRAINT customer_order_items_tenant_suborder_item_key
  UNIQUE (tenant_id, suborder_id, id);

CREATE TABLE merchant_order_item_preparation_checks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  suborder_id text NOT NULL,
  order_item_id text NOT NULL,
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  actor_id text NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 200),
  expected_sku text NOT NULL CHECK (length(trim(expected_sku)) BETWEEN 1 AND 120),
  scanned_sku text,
  expected_quantity integer NOT NULL CHECK (expected_quantity > 0),
  verified_quantity integer NOT NULL DEFAULT 0 CHECK (verified_quantity >= 0),
  size_label text,
  color_label text,
  outcome text NOT NULL CHECK (outcome IN ('verified','shortage','damaged','sku_mismatch')),
  note text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id, suborder_id)
    REFERENCES merchant_suborders(tenant_id, order_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, suborder_id, order_item_id)
    REFERENCES customer_order_items(tenant_id, suborder_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, branch_id)
    REFERENCES merchant_branches(merchant_id, id) ON DELETE RESTRICT,
  CHECK (
    (outcome = 'verified' AND scanned_sku = expected_sku
      AND verified_quantity = expected_quantity)
    OR (outcome = 'shortage' AND verified_quantity < expected_quantity)
    OR (outcome = 'damaged' AND verified_quantity <= expected_quantity)
    OR (outcome = 'sku_mismatch' AND scanned_sku IS NOT NULL
      AND scanned_sku <> expected_sku AND verified_quantity = 0)
  ),
  CHECK (note IS NULL OR length(note) <= 1000),
  UNIQUE (tenant_id, suborder_id, order_item_id)
);
CREATE INDEX merchant_order_item_preparation_checks_branch_idx
  ON merchant_order_item_preparation_checks
  (tenant_id, merchant_id, branch_id, checked_at DESC);
