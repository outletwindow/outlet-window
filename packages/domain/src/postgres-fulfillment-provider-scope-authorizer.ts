import type { PostgresQueryable } from "./postgres-iam-store.js";
import type { VerifiedFulfillmentHandoverEvent } from "./fulfillment-handover-provider.js";

/**
 * Resolves carrier authority from exactly one connected tenant integration
 * and its explicit merchant/branch grant. Missing or ambiguous matches fail closed.
 */
export class PostgresFulfillmentProviderScopeAuthorizer {
  constructor(private readonly db: PostgresQueryable) {}

  async isAuthorized(providerKey: string, event: VerifiedFulfillmentHandoverEvent): Promise<boolean> {
    const result = await this.db.query<{ authorized: boolean }>(
      `SELECT (
         SELECT COUNT(*) = 1
         FROM tenant_integrations candidate
         WHERE candidate.tenant_id = $1
           AND candidate.provider_key = $2
           AND candidate.family = 'carriers'
           AND candidate.status = 'connected'
       ) AND EXISTS (
         SELECT 1
         FROM tenant_integrations i
         JOIN fulfillment_provider_branch_scopes s
           ON s.tenant_id = i.tenant_id AND s.integration_id = i.id
         JOIN merchants m
           ON m.tenant_id = i.tenant_id AND m.id = s.merchant_id
         JOIN merchant_branches b
           ON b.merchant_id = s.merchant_id AND b.id = s.branch_id
         WHERE i.tenant_id = $1
           AND i.provider_key = $2
           AND i.family = 'carriers'
           AND i.status = 'connected'
           AND s.active = true
           AND s.merchant_id = $3
           AND s.branch_id = $4
           AND m.status = 'active'
           AND b.status = 'active'
       ) AS authorized`,
      [event.tenantId, providerKey, event.merchantId, event.branchId]
    );
    return result.rows[0]?.authorized === true;
  }
}
