import type { PostgresQueryable } from "./postgres-iam-store.js";

export interface BranchInventoryRecord {
  productVariantId: string;
  sku: string;
  availableQuantity: number;
  reservedQuantity: number;
  source: "pos" | "erp" | "ecommerce" | "csv" | "merchant_portal" | "manual";
  lastSyncedAtUtc: string;
  confidence: "high" | "medium" | "low" | "unknown";
}

type InventoryRow = {
  product_variant_id: string;
  sku: string;
  available_quantity: number;
  reserved_quantity: number;
  source: BranchInventoryRecord["source"];
  last_synced_at: Date | string;
  availability_confidence: BranchInventoryRecord["confidence"];
};

function identifier(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 160;
}

export interface BranchInventoryReconciliationAlertRecord {
  id: string;
  productVariantId: string;
  source: BranchInventoryRecord["source"];
  capturedAtUtc: string;
  reportedAvailableQuantity: number;
  platformReservedQuantity: number;
  createdAtUtc: string;
}

type ReconciliationAlertRow = {
  id: string;
  product_variant_id: string;
  source: BranchInventoryRecord["source"];
  captured_at: Date | string;
  reported_available_quantity: number;
  platform_reserved_quantity: number;
  created_at: Date | string;
};

/** Tenant- and branch-scoped inventory read model for merchant operations. */
export class PostgresBranchInventoryReader {
  constructor(private readonly db: PostgresQueryable) {}

  async list(input: {
    tenantId: string;
    merchantId: string;
    branchId: string;
    limit?: number;
  }): Promise<readonly BranchInventoryRecord[]> {
    if (!identifier(input.tenantId) || !identifier(input.merchantId) ||
        !identifier(input.branchId) || !Number.isSafeInteger(input.limit ?? 50) ||
        (input.limit ?? 50) < 1 || (input.limit ?? 50) > 100) {
      throw new Error("invalid_branch_inventory_read");
    }
    const result = await this.db.query<InventoryRow>(
      `SELECT i.product_variant_id, i.sku, i.available_quantity, i.reserved_quantity,
              i.source, i.last_synced_at, i.availability_confidence
       FROM branch_inventory i
       JOIN merchant_branches b
         ON b.merchant_id = i.merchant_id AND b.id = i.branch_id
       JOIN merchants m ON m.id = b.merchant_id
       WHERE m.tenant_id = $1 AND m.id = $2 AND b.id = $3
         AND m.status = 'active' AND b.status = 'active'
       ORDER BY i.product_variant_id ASC
       LIMIT $4`,
      [input.tenantId, input.merchantId, input.branchId, input.limit ?? 50]
    );
    return result.rows.map(row => ({
      productVariantId: row.product_variant_id,
      sku: row.sku,
      availableQuantity: row.available_quantity,
      reservedQuantity: row.reserved_quantity,
      source: row.source,
      lastSyncedAtUtc: new Date(row.last_synced_at).toISOString(),
      confidence: row.availability_confidence
    }));
  }

  async listOpenReconciliationAlerts(input: {
    tenantId: string;
    merchantId: string;
    branchId: string;
    limit?: number;
  }): Promise<readonly BranchInventoryReconciliationAlertRecord[]> {
    if (!identifier(input.tenantId) || !identifier(input.merchantId) ||
        !identifier(input.branchId) || !Number.isSafeInteger(input.limit ?? 50) ||
        (input.limit ?? 50) < 1 || (input.limit ?? 50) > 100) {
      throw new Error("invalid_branch_inventory_reconciliation_read");
    }
    const result = await this.db.query<ReconciliationAlertRow>(
      `SELECT a.id, a.product_variant_id, a.source, a.captured_at,
              a.reported_available_quantity, a.platform_reserved_quantity, a.created_at
       FROM branch_inventory_reconciliation_alerts a
       JOIN merchant_branches b
         ON b.merchant_id = a.merchant_id AND b.id = a.branch_id
       JOIN merchants m ON m.id = b.merchant_id
       WHERE a.tenant_id = $1 AND a.merchant_id = $2 AND a.branch_id = $3
         AND a.status = 'open'
       ORDER BY a.created_at DESC, a.id
       LIMIT $4`,
      [input.tenantId, input.merchantId, input.branchId, input.limit ?? 50]
    );
    return result.rows.map(row => ({
      id: row.id,
      productVariantId: row.product_variant_id,
      source: row.source,
      capturedAtUtc: new Date(row.captured_at).toISOString(),
      reportedAvailableQuantity: row.reported_available_quantity,
      platformReservedQuantity: row.platform_reserved_quantity,
      createdAtUtc: new Date(row.created_at).toISOString()
    }));
  }

}
