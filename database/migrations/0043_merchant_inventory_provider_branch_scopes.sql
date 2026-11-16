-- Explicit POS/ERP branch grants for external inventory hard reservations.
-- A connected integration alone is insufficient: capability and exact branch scope are required.
CREATE TABLE IF NOT EXISTS merchant_inventory_provider_branch_scopes (
  tenant_id text NOT NULL,
  integration_id text NOT NULL,
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, integration_id, merchant_id, branch_id),
  FOREIGN KEY (tenant_id, integration_id)
    REFERENCES tenant_integrations (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES merchants (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id, branch_id)
    REFERENCES merchant_branches (merchant_id, id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);
CREATE INDEX IF NOT EXISTS merchant_inventory_provider_branch_scopes_active_idx
  ON merchant_inventory_provider_branch_scopes
    (tenant_id, merchant_id, branch_id, integration_id)
  WHERE active = true;
