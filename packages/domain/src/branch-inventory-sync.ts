import { randomUUID } from "node:crypto";
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
        !Array.isArray(input.lines) || input.lines.length > 5000) {
      throw new Error("INVALID_BRANCH_INVENTORY_SNAPSHOT");
    }
    if (Date.parse(input.capturedAtUtc) > this.now().getTime()) {
      throw new Error("FUTURE_BRANCH_INVENTORY_SNAPSHOT");
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
      const branch = await client.query<{ id: string; inventory_snapshot_at: Date | string | null }>(
        `SELECT b.id, b.inventory_snapshot_at FROM merchant_branches b
         JOIN merchants m ON m.id = b.merchant_id
         WHERE m.tenant_id = $1 AND m.id = $2 AND b.id = $3
           AND m.status = 'active' AND b.status = 'active'
         FOR UPDATE OF b`,
        [input.tenantId, input.merchantId, input.branchId]
      );
      if (branch.rows.length !== 1) throw new Error("BRANCH_INVENTORY_SCOPE_NOT_FOUND");

      // The branch row is locked for the whole transaction. Enforce ordering at the
      // snapshot level before touching any variant, including variants omitted here.
      const latestSnapshotAt = branch.rows[0]!.inventory_snapshot_at;
      if (latestSnapshotAt !== null &&
          Date.parse(input.capturedAtUtc) <= new Date(latestSnapshotAt).getTime()) {
        await client.query("COMMIT");
        return { accepted: 0, stale: input.lines.length };
      }
      await client.query(
        `UPDATE merchant_branches
         SET inventory_snapshot_at = $3, inventory_snapshot_source = $4
         WHERE merchant_id = $1 AND id = $2`,
        [input.merchantId, input.branchId, input.capturedAtUtc, input.source]
      );

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
        if (result.rows.length === 1) {
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
            // The source-of-truth count is below our active reservations. Never keep
            // the previous free quantity sellable: clamp on-hand to reserved (zero free),
            // downgrade confidence, and persist a durable reconciliation alert atomically.
            const clamped = await client.query(
              `UPDATE branch_inventory
               SET available_quantity = reserved_quantity, source = $4,
                   last_synced_at = $5, availability_confidence = 'low', updated_at = now()
               WHERE merchant_id = $1 AND branch_id = $2 AND product_variant_id = $3
                 AND last_synced_at <= $5
               RETURNING reserved_quantity`,
              [input.merchantId, input.branchId, line.productVariantId, input.source, input.capturedAtUtc]
            );
            if (clamped.rows.length === 1) {
              const reservedQuantity = Number(clamped.rows[0]!.reserved_quantity);
              await client.query(
                `INSERT INTO branch_inventory_reconciliation_alerts
                 (id, tenant_id, merchant_id, branch_id, product_variant_id, source,
                  captured_at, reported_available_quantity, platform_reserved_quantity)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT (merchant_id, branch_id, product_variant_id, captured_at) DO NOTHING`,
                [randomUUID(), input.tenantId, input.merchantId, input.branchId,
                  line.productVariantId, input.source, input.capturedAtUtc,
                  line.availableQuantity, reservedQuantity]
              );
              accepted++;
              continue;
            }
          }
          stale++;
        }
      }

      // This API accepts complete branch snapshots, not incremental deltas. A variant
      // omitted from a newer complete snapshot must stop being sellable immediately.
      // Keep reserved_quantity intact and set on-hand equal to reserved so free stock is 0.
      // The timestamp guard prevents an older snapshot from clearing newer inventory.
      const omitted = await client.query(
        `UPDATE branch_inventory
         SET available_quantity = reserved_quantity, source = $4,
             last_synced_at = $5, availability_confidence = $6, updated_at = now()
         WHERE merchant_id = $1 AND branch_id = $2
           AND NOT (product_variant_id = ANY($3::text[]))
           AND last_synced_at <= $5
         RETURNING product_variant_id`,
        [input.merchantId, input.branchId,
          input.lines.map(line => line.productVariantId),
          input.source, input.capturedAtUtc, input.confidence]
      );
      accepted += omitted.rows.length;

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
