import type { PostgresPool } from "./postgres-iam-store.js";

export type PreparationOutcome = "verified" | "shortage" | "damaged" | "sku_mismatch";
export interface RecordPreparationCheckInput {
  id: string;
  tenantId: string;
  orderId: string;
  suborderId: string;
  orderItemId: string;
  merchantId: string;
  branchId: string;
  actorId: string;
  scannedSku?: string;
  verifiedQuantity: number;
  outcome: PreparationOutcome;
  note?: string;
}
export type RecordPreparationCheckResult =
  | { outcome: "recorded"; expectedSku: string; expectedQuantity: number }
  | { outcome: "already_recorded"; expectedSku: string; expectedQuantity: number }
  | { outcome: "not_found" }
  | { outcome: "invalid_check"; reason: string }
  | { outcome: "conflict" };

type OrderItemRow = {
  sku: string; quantity: number; size_label: string | null; color_label: string | null;
};
type ExistingCheckRow = {
  id: string; actor_id: string; scanned_sku: string | null;
  verified_quantity: number; outcome: PreparationOutcome; note: string | null;
};

function validText(value: string, max: number): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/**
 * Persists one immutable branch-scoped item verification.
 * Expected SKU and quantity are always read from the locked order item;
 * callers cannot supply or override them.
 */
export class PostgresMerchantOrderItemPreparationStore {
  constructor(private readonly pool: PostgresPool) {}

  async record(input: RecordPreparationCheckInput): Promise<RecordPreparationCheckResult> {
    for (const [value, max] of [
      [input.id, 200], [input.tenantId, 200], [input.orderId, 200],
      [input.suborderId, 200], [input.orderItemId, 200],
      [input.merchantId, 200], [input.branchId, 200], [input.actorId, 200]
    ] as const) {
      if (!validText(value, max)) return { outcome: "invalid_check", reason: "invalid_identifier" };
    }
    if (!Number.isSafeInteger(input.verifiedQuantity) || input.verifiedQuantity < 0) {
      return { outcome: "invalid_check", reason: "invalid_quantity" };
    }
    if (input.scannedSku !== undefined && (typeof input.scannedSku !== "string" || input.scannedSku.length > 120)) {
      return { outcome: "invalid_check", reason: "invalid_scanned_sku" };
    }
    if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 1000)) {
      return { outcome: "invalid_check", reason: "invalid_note" };
    }
    if (!["verified", "shortage", "damaged", "sku_mismatch"].includes(input.outcome)) {
      return { outcome: "invalid_check", reason: "invalid_outcome" };
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const itemResult = await client.query<OrderItemRow>(
        `SELECT i.sku, i.quantity, i.size_label, i.color_label
         FROM customer_order_items i
         JOIN merchant_suborders s
           ON s.tenant_id = i.tenant_id AND s.order_id = i.order_id AND s.id = i.suborder_id
         WHERE i.tenant_id = $1 AND i.order_id = $2 AND i.suborder_id = $3
           AND i.id = $4 AND i.merchant_id = $5 AND i.branch_id = $6
           AND s.merchant_id = $5 AND s.branch_id = $6
         FOR UPDATE OF i, s`,
        [input.tenantId, input.orderId, input.suborderId, input.orderItemId, input.merchantId, input.branchId]
      );
      if (itemResult.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      const item = itemResult.rows[0]!;
      const scannedSku = input.scannedSku ?? null;
      const valid =
        (input.outcome === "verified" && scannedSku === item.sku && input.verifiedQuantity === item.quantity) ||
        (input.outcome === "shortage" && input.verifiedQuantity < item.quantity) ||
        (input.outcome === "damaged" && input.verifiedQuantity <= item.quantity) ||
        (input.outcome === "sku_mismatch" && scannedSku !== null && scannedSku !== item.sku && input.verifiedQuantity === 0);
      if (!valid) {
        await client.query("ROLLBACK");
        return { outcome: "invalid_check", reason: "check_does_not_match_persisted_item" };
      }

      const existing = await client.query<ExistingCheckRow>(
        `SELECT id, actor_id, scanned_sku, verified_quantity, outcome, note
         FROM merchant_order_item_preparation_checks
         WHERE tenant_id = $1 AND suborder_id = $2 AND order_item_id = $3
         FOR UPDATE`,
        [input.tenantId, input.suborderId, input.orderItemId]
      );
      if (existing.rowCount) {
        const row = existing.rows[0]!;
        const same = row.actor_id === input.actorId &&
          row.scanned_sku === scannedSku && row.verified_quantity === input.verifiedQuantity &&
          row.outcome === input.outcome && row.note === (input.note ?? null);
        await client.query("COMMIT");
        return same
          ? { outcome: "already_recorded", expectedSku: item.sku, expectedQuantity: item.quantity }
          : { outcome: "conflict" };
      }

      await client.query(
        `INSERT INTO merchant_order_item_preparation_checks
         (id, tenant_id, order_id, suborder_id, order_item_id, merchant_id, branch_id,
          actor_id, expected_sku, scanned_sku, expected_quantity, verified_quantity,
          size_label, color_label, outcome, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [input.id, input.tenantId, input.orderId, input.suborderId, input.orderItemId,
          input.merchantId, input.branchId, input.actorId, item.sku, scannedSku,
          item.quantity, input.verifiedQuantity, item.size_label, item.color_label,
          input.outcome, input.note ?? null]
      );
      await client.query("COMMIT");
      return { outcome: "recorded", expectedSku: item.sku, expectedQuantity: item.quantity };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
