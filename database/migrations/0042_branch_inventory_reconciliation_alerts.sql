-- Record source-of-truth stock counts that fall below Outlet Window's active reservations.
-- The sync transaction will clamp sellable stock to zero and persist the discrepancy.
CREATE TABLE IF NOT EXISTS branch_inventory_reconciliation_alerts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  product_variant_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('pos','erp','ecommerce','csv','merchant_portal','manual')),
  captured_at timestamptz NOT NULL,
  reported_available_quantity integer NOT NULL CHECK (reported_available_quantity >= 0),
  platform_reserved_quantity integer NOT NULL CHECK (platform_reserved_quantity >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES merchants(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, branch_id)
    REFERENCES merchant_branches(merchant_id, id) ON DELETE RESTRICT,
  UNIQUE (merchant_id, branch_id, product_variant_id, captured_at),
  CHECK ((status = 'open' AND resolved_at IS NULL) OR
         (status = 'resolved' AND resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS branch_inventory_reconciliation_open_idx
  ON branch_inventory_reconciliation_alerts (tenant_id, created_at DESC)
  WHERE status = 'open';
