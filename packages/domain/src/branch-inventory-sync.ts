import type { PostgresPool } from "./postgres-iam-store.js";

export type BranchInventorySource = "pos" | "erp" | "ecommerce" | "csv" | "merchant_portal" | "manual";
export type InventoryConfidence = "high" | "medium" | "low" | "unknown";

export interface BranchInventorySnapshotLine {
  productVariantId: string;
  sku: string;
  availableQuantity: number;
}
export interface BranchInventorySyncRequest {
  tenantId: string;
  merchantId: string;
  branchId: string;
  source: BranchInventorySource;
  capturedAtUtc: string;
  lines: readonly BranchInventorySnapshotLine[];
}
export interface BranchInventorySyncResult {
  accepted: number;
  stale: number;
  confidence: InventoryConfidence;
  capturedAtUtc: string;
}
export interface BranchInventorySyncStore {
  applySnapshot(input: BranchInventorySyncRequest & { confidence: InventoryConfidence }): Promise<{ accepted: number; stale: number }>;
}

const SOURCES: readonly BranchInventorySource[] = ["pos","erp","ecommerce","csv","merchant_portal","manual"];
function validUtc(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && value.endsWith("Z") && new Date(time).toISOString() === value;
}

/** Confidence reflects source freshness, never a guarantee of physical stock. */
export function inventoryConfidence(capturedAtUtc: string, nowUtc: string): InventoryConfidence {
  const age = Date.parse(nowUtc) - Date.parse(capturedAtUtc);
  if (!Number.isFinite(age) || age < 0) return "unknown";
  if (age <= 5 * 60_000) return "high";
  if (age <= 30 * 60_000) return "medium";
  return "low";
}

/** Validates and applies a complete branch-scoped stock snapshot. */
export class BranchInventorySyncService {
  constructor(private readonly store: BranchInventorySyncStore, private readonly now: () => Date = () => new Date()) {}

  async sync(input: BranchInventorySyncRequest): Promise<BranchInventorySyncResult> {
    if (!input.tenantId.trim() || input.tenantId.length > 160 ||
        !input.merchantId.trim() || input.merchantId.length > 160 ||
        !input.branchId.trim() || input.branchId.length > 160 ||
        !SOURCES.includes(input.source) || !validUtc(input.capturedAtUtc) ||
        !Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 5000) {
      throw new Error("INVALID_BRANCH_INVENTORY_SNAPSHOT");
    }
    const seen = new Set<string>();
    for (const line of input.lines) {
      if (!line.productVariantId.trim() || line.productVariantId.length > 200 ||
          !line.sku.trim() || line.sku.length > 120 ||
          !Number.isSafeInteger(line.availableQuantity) || line.availableQuantity < 0 ||
          seen.has(line.productVariantId)) {
        throw new Error("INVALID_BRANCH_INVENTORY_LINE");
      }
      seen.add(line.productVariantId);
    }
    const confidence = inventoryConfidence(input.capturedAtUtc, this.now().toISOString());
    const result = await this.store.applySnapshot({ ...input, confidence });
    return { ...result, confidence, capturedAtUtc: input.capturedAtUtc };
  }
}

/** Tenant-checked, branch-scoped snapshot persistence. Older snapshots cannot overwrite newer stock. */
export class PostgresBranchInventorySyncStore implements BranchInventorySyncStore {
  constructor(private readonly pool: PostgresPool) {}

  async applySnapshot(input: BranchInventorySyncRequest & { confidence: InventoryConfidence }): Promise<{ accepted: number; stale: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const branch = await client.query<{ id: string }>(
        `SELECT b.id FROM merchant_branches b
         JOIN merchants m ON m.id = b.merchant_id
         WHERE m.tenant_id = $1 AND m.id = $2 AND b.id = $3
           AND m.status = 'active' AND b.status = 'active'
         FOR UPDATE OF b`,
        [input.tenantId, input.merchantId, input.branchId]
      );
      if (branch.rowCount !== 1) throw new Error("BRANCH_INVENTORY_SCOPE_NOT_FOUND");

      let accepted = 0;
      let stale = 0;
      for (const line of input.lines) {
        const result = await client.query(
          `INSERT INTO branch_inventory
           (merchant_id, branch_id, product_variant_id, sku, available_quantity,
            reserved_quantity, source, last_synced_at, availability_confidence, updated_at)
           VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,now())
           ON CONFLICT (merchant_id, branch_id, product_variant_id)
           DO UPDATE SET sku=EXCLUDED.sku, available_quantity=EXCLUDED.available_quantity,
             source=EXCLUDED.source, last_synced_at=EXCLUDED.last_synced_at,
             availability_confidence=EXCLUDED.availability_confidence, updated_at=now()
           WHERE branch_inventory.last_synced_at <= EXCLUDED.last_synced_at
             AND EXCLUDED.available_quantity >= branch_inventory.reserved_quantity
           RETURNING product_variant_id`,
          [input.merchantId,input.branchId,line.productVariantId,line.sku,line.availableQuantity,input.source,input.capturedAtUtc,input.confidence]
        );
        if (result.rowCount === 1) {
          accepted++;
        } else {
          const current = await client.query<{ last_synced_at: Date | string; reserved_quantity: number }>(
            `SELECT last_synced_at, reserved_quantity FROM branch_inventory
             WHERE merchant_id = $1 AND branch_id = $2 AND product_variant_id = $3`,
            [input.merchantId, input.branchId, line.productVariantId]
          );
          const row = current.rows[0];
          if (row && Date.parse(input.capturedAtUtc) >= new Date(row.last_synced_at).getTime() &&
              line.availableQuantity < row.reserved_quantity) {
            throw new Error("BRANCH_INVENTORY_RESERVED_STOCK_CONFLICT");
          }
          stale++;
        }
      }
      await client.query("COMMIT");
      return { accepted, stale };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
