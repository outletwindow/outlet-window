import type { PostgresQueryable } from "./postgres-iam-store.js";

export interface InventoryProviderBranchScopeInput {
  tenantId: string;
  integrationId: string;
  merchantId: string;
  branchId: string;
}

export type InventoryProviderBranchScopeGrantResult = "granted" | "not_eligible";
export type InventoryProviderBranchScopeRevokeResult = "revoked" | "not_found";

/**
 * Platform-controlled branch grants for POS/ERP hard-reservation integrations.
 * A grant is only created for a connected provider with the platform-approved
 * hard-reservation capability and an active merchant/branch in the same tenant.
 */
export class PostgresInventoryProviderBranchScopeStore {
  constructor(private readonly database: PostgresQueryable) {}

  async grant(input: InventoryProviderBranchScopeInput): Promise<InventoryProviderBranchScopeGrantResult> {
    const result = await this.database.query<{ integration_id: string }>(
      `INSERT INTO merchant_inventory_provider_branch_scopes
         (tenant_id, integration_id, merchant_id, branch_id, active, created_at, updated_at)
       SELECT i.tenant_id, i.id, m.id, b.id, true, now(), now()
       FROM tenant_integrations i
       JOIN merchants m ON m.tenant_id = i.tenant_id AND m.id = $3 AND m.status = 'active'
       JOIN merchant_branches b ON b.merchant_id = m.id AND b.id = $4 AND b.status = 'active'
       WHERE i.tenant_id = $1
         AND i.id = $2
         AND i.family IN ('pos', 'erp')
         AND i.status = 'connected'
         AND i.capabilities @> '[\"inventory.hard_reservation\"]'::jsonb
       ON CONFLICT (tenant_id, integration_id, merchant_id, branch_id)
       DO UPDATE SET active = true, updated_at = now()
       RETURNING integration_id`,
      [input.tenantId, input.integrationId, input.merchantId, input.branchId]
    );
    return result.rowCount === 1 ? "granted" : "not_eligible";
  }

  async revoke(input: InventoryProviderBranchScopeInput): Promise<InventoryProviderBranchScopeRevokeResult> {
    const result = await this.database.query<{ integration_id: string }>(
      `UPDATE merchant_inventory_provider_branch_scopes
       SET active = false, updated_at = now()
       WHERE tenant_id = $1 AND integration_id = $2
         AND merchant_id = $3 AND branch_id = $4 AND active = true
       RETURNING integration_id`,
      [input.tenantId, input.integrationId, input.merchantId, input.branchId]
    );
    return result.rowCount === 1 ? "revoked" : "not_found";
  }
}
