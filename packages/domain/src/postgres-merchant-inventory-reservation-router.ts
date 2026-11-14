import type {
  InventoryReservationPort, InventoryReservationPortResult, InventoryReservationRequest
} from "./inventory-reservation.js";
import type { PostgresQueryable } from "./postgres-iam-store.js";

type EligibleInventoryProvider = { id: string; provider_key: string };

/**
 * Routes exact-variant hard reservations only to one connected POS/ERP integration
 * with the explicit inventory.hard_reservation capability and an active branch grant.
 * Provider adapters are injected; missing, ambiguous, or unsupported integrations fail closed.
 */
export class PostgresMerchantInventoryReservationRouter implements InventoryReservationPort {
  constructor(
    private readonly db: PostgresQueryable,
    private readonly adapters: ReadonlyMap<string, InventoryReservationPort>
  ) {}

  async reserveExactVariants(
    request: InventoryReservationRequest
  ): Promise<InventoryReservationPortResult> {
    const result = await this.db.query<EligibleInventoryProvider>(
      `SELECT i.id, i.provider_key
       FROM tenant_integrations i
       JOIN merchant_inventory_provider_branch_scopes s
         ON s.tenant_id = i.tenant_id AND s.integration_id = i.id
       JOIN merchants m
         ON m.tenant_id = i.tenant_id AND m.id = s.merchant_id
       JOIN merchant_branches b
         ON b.merchant_id = s.merchant_id AND b.id = s.branch_id
       WHERE i.tenant_id = $1
         AND i.family IN ('pos','erp')
         AND i.status = 'connected'
         AND i.capabilities @> '["inventory.hard_reservation"]'::jsonb
         AND s.active = true
         AND s.merchant_id = $2
         AND s.branch_id = $3
         AND m.status = 'active'
         AND b.status = 'active'
       ORDER BY i.id
       LIMIT 2`,
      [request.tenantId, request.merchantId, request.branchId]
    );
    if (result.rows.length === 0) {
      return { outcome: "unsupported", reason: "merchant_integration_missing" };
    }
    if (result.rows.length !== 1) {
      return { outcome: "unsupported", reason: "hard_reservation_not_supported" };
    }
    const adapter = this.adapters.get(result.rows[0]!.provider_key);
    if (!adapter) {
      return { outcome: "unsupported", reason: "hard_reservation_not_supported" };
    }
    // Bind the provider's exact tenant integration selected by the scoped grant query.
    // Adapters can now resolve the matching secret reference without guessing by provider key.
    return adapter.reserveExactVariants({ ...request, providerIntegrationId: result.rows[0]!.id });
  }
}
