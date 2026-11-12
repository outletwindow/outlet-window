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
}
