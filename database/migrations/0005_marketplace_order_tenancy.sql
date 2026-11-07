-- Separate the marketplace order's platform tenant from each merchant's tenant.
CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  tenant_type text NOT NULL CHECK (tenant_type IN ('platform','merchant')),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('active','suspended','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenants (id, tenant_type, display_name, status)
VALUES ('platform', 'platform', 'Outlet Window Platform', 'active')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE merchants ADD COLUMN tenant_id text;
UPDATE merchants SET tenant_id = id WHERE tenant_id IS NULL;
INSERT INTO tenants (id, tenant_type, display_name, status)
SELECT id, 'merchant', display_name, CASE WHEN status = 'active' THEN 'active' ELSE 'suspended' END
FROM merchants
ON CONFLICT (id) DO NOTHING;
ALTER TABLE merchants ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE merchants
  ADD CONSTRAINT merchants_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE merchants
  ADD CONSTRAINT merchants_tenant_id_id_key UNIQUE (tenant_id, id);

-- Preserve any pre-existing order tenant IDs while making them explicit tenants.
INSERT INTO tenants (id, tenant_type, display_name, status)
SELECT DISTINCT o.tenant_id, 'platform', 'Migrated order tenant ' || o.tenant_id, 'active'
FROM customer_orders o
ON CONFLICT (id) DO NOTHING;
ALTER TABLE customer_orders
  ADD CONSTRAINT customer_orders_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

-- A parent order belongs to the platform/customer tenant. Each suborder belongs
-- to the merchant tenant and is linked to its parent by the globally unique order ID.
ALTER TABLE merchant_suborders
  DROP CONSTRAINT merchant_suborders_tenant_id_order_id_fkey;
ALTER TABLE merchant_suborders
  DROP CONSTRAINT merchant_suborders_merchant_id_branch_id_fkey;
UPDATE merchant_suborders s
SET tenant_id = m.tenant_id
FROM merchants m
WHERE m.id = s.merchant_id;
ALTER TABLE merchant_suborders
  ADD CONSTRAINT merchant_suborders_order_fk
  FOREIGN KEY (order_id) REFERENCES customer_orders(id) ON DELETE RESTRICT;
ALTER TABLE merchant_suborders
  ADD CONSTRAINT merchant_suborders_merchant_tenant_fk
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE merchant_suborders
  ADD CONSTRAINT merchant_suborders_merchant_branch_fk
  FOREIGN KEY (merchant_id, branch_id) REFERENCES merchant_branches(merchant_id, id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS merchant_suborders_order_status_idx
  ON merchant_suborders (order_id, status, id);
