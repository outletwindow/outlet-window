-- Explicit carrier authorization per tenant, merchant, and branch.
-- A connected carrier integration receives no branch access unless this grant exists.
CREATE TABLE fulfillment_provider_branch_scopes (
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
CREATE INDEX fulfillment_provider_branch_scopes_active_idx
  ON fulfillment_provider_branch_scopes (tenant_id, merchant_id, branch_id, integration_id)
  WHERE active = true;
