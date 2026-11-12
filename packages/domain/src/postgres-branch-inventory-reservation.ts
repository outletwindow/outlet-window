import { randomUUID } from "node:crypto";
import type { InventoryReservationPort, InventoryReservationRequest, InventoryReservationPortResult } from "./inventory-reservation.js";
import type { PostgresPool } from "./postgres-iam-store.js";

type SuborderRow = { id: string; order_id: string; tenant_id: string; merchant_id: string; branch_id: string };
type OrderLineRow = { product_variant_id: string; sku: string; quantity: number };
type StockRow = {
  product_variant_id: string; sku: string; available_quantity: number; reserved_quantity: number;
};

function sameLines(actual: readonly OrderLineRow[], requested: InventoryReservationRequest["lines"]): boolean {
  const a = [...actual].sort((x, y) => x.product_variant_id.localeCompare(y.product_variant_id));
  const b = [...requested].sort((x, y) => x.productVariantId.localeCompare(y.productVariantId));
  return a.length === b.length && a.every((line, index) =>
    line.product_variant_id === b[index]?.productVariantId &&
    line.sku === b[index]?.sku && line.quantity === b[index]?.quantity
  );
}

/**
 * PostgreSQL-backed platform inventory ledger.
 * It atomically allocates the exact order lines against the selected branch's tracked stock.
 * This prevents platform-side overselling; it does not claim that an external POS/ERP has
 * acknowledged a hard reservation unless that merchant integration explicitly provides it.
 */
export class PostgresBranchInventoryReservationAdapter implements InventoryReservationPort {
  constructor(
    private readonly pool: PostgresPool,
    private readonly createId: () => string = randomUUID
  ) {}

  async reserveExactVariants(request: InventoryReservationRequest): Promise<InventoryReservationPortResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Serialize retries sharing an idempotency key before checking the ledger.
      // Without this lock, concurrent first attempts can both observe no row and
      // the loser may incorrectly return "unavailable" instead of the prior result.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [request.idempotencyKey]);

      const existing = await client.query<{
        id: string; tenant_id: string; order_id: string; suborder_id: string;
        merchant_id: string; branch_id: string; status: string;
      }>(
        "SELECT id, tenant_id, order_id, suborder_id, merchant_id, branch_id, status FROM inventory_reservations WHERE idempotency_key = $1 FOR UPDATE",
        [request.idempotencyKey]
      );
      if (existing.rowCount) {
        const row = existing.rows[0]!;
        const same = row.tenant_id === request.tenantId && row.order_id === request.orderId &&
          row.suborder_id === request.suborderId && row.merchant_id === request.merchantId &&
          row.branch_id === request.branchId;
        if (!same || row.status !== "reserved") throw new Error("inventory_reservation_idempotency_conflict");
        const lines = await client.query<OrderLineRow>(
          "SELECT COALESCE(catalog_variant_id, product_variant_id) AS product_variant_id, sku, quantity FROM inventory_reservation_lines WHERE reservation_id = $1 ORDER BY product_variant_id",
          [row.id]
        );
        if (!sameLines(lines.rows, request.lines)) throw new Error("inventory_reservation_idempotency_conflict");
        await client.query("COMMIT");
        return { outcome: "reserved", reservationReference: row.id };
      }

      // Lock the parent and exact merchant suborder. Payment capture evidence is required.
      const suborder = await client.query<SuborderRow>(
        `SELECT s.id, s.order_id, s.tenant_id, s.merchant_id, s.branch_id
         FROM merchant_suborders s
         JOIN customer_orders o ON o.id = s.order_id
         WHERE s.tenant_id = $1 AND s.order_id = $2 AND s.id = $3
           AND s.merchant_id = $4 AND s.branch_id = $5
           AND o.status = 'awaiting_payment'
           AND (
             EXISTS (
               SELECT 1 FROM verified_order_payment_captures p
               WHERE p.tenant_id = o.tenant_id AND p.order_id = o.id
                 AND p.amount_minor = o.total_minor AND p.currency = o.currency
             )
           )
         FOR UPDATE OF o, s`,
        [request.tenantId, request.orderId, request.suborderId, request.merchantId, request.branchId]
      );
      if (!suborder.rowCount) throw new Error("inventory_reservation_paid_suborder_not_found");

      const orderLines = await client.query<OrderLineRow>(
        `SELECT oi.product_variant_id, oi.sku, oi.quantity
         FROM customer_order_items oi
         WHERE oi.tenant_id = $1 AND oi.order_id = $2 AND oi.suborder_id = $3
           AND oi.merchant_id = $4 AND oi.branch_id = $5
         ORDER BY oi.product_variant_id`,
        [request.tenantId, request.orderId, request.suborderId, request.merchantId, request.branchId]
      );
      if (!sameLines(orderLines.rows, request.lines)) {
        throw new Error("inventory_reservation_order_lines_mismatch");
      }

      const variantIds = request.lines.map(line => line.productVariantId).sort();
      // Cart/order lines use the platform catalog variant ID. Branch inventory is keyed
      // by the merchant's external variant ID, so resolve that mapping from the catalog.
      // The COALESCE fallback preserves legacy/manual order lines created before catalog linking.
      const stock = await client.query<StockRow & { catalog_variant_id: string }>(
        `SELECT i.product_variant_id, oi.product_variant_id AS catalog_variant_id,
                i.sku, i.available_quantity, i.reserved_quantity
         FROM customer_order_items oi
         LEFT JOIN commerce_catalog_variants v
           ON v.tenant_id = oi.tenant_id AND v.id = oi.product_variant_id
         JOIN branch_inventory i
           ON i.merchant_id = oi.merchant_id AND i.branch_id = oi.branch_id
          AND i.product_variant_id = COALESCE(v.external_variant_id, oi.product_variant_id)
          AND i.sku = oi.sku
         JOIN merchant_branches b
           ON b.merchant_id = i.merchant_id AND b.id = i.branch_id
         JOIN merchants m ON m.id = b.merchant_id
         WHERE oi.tenant_id = $1 AND oi.order_id = $2 AND oi.suborder_id = $3
           AND oi.merchant_id = $4 AND oi.branch_id = $5
           AND oi.product_variant_id = ANY($6::text[])
           AND m.tenant_id = $1 AND m.id = $4 AND b.id = $5
           AND m.status = 'active' AND b.status = 'active'
           AND i.last_synced_at >= clock_timestamp() - interval '30 minutes'
           AND i.availability_confidence IN ('high','medium')
         ORDER BY oi.product_variant_id
         FOR UPDATE OF m, b, i`,
        [request.tenantId, request.orderId, request.suborderId, request.merchantId, request.branchId, variantIds]
      );
      const stockByVariant = new Map(stock.rows.map(row => [row.catalog_variant_id, row]));
      const unavailable = request.lines.filter(line => {
        const row = stockByVariant.get(line.productVariantId);
        return !row || row.sku !== line.sku ||
          row.available_quantity - row.reserved_quantity < line.quantity;
      }).map(line => line.productVariantId);

      if (unavailable.length) {
        await client.query("COMMIT");
        return { outcome: "unavailable", unavailableLines: unavailable };
      }

      const reservationId = this.createId();
      await client.query(
        `INSERT INTO inventory_reservations
         (id, tenant_id, order_id, suborder_id, merchant_id, branch_id, idempotency_key,
          status, requested_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9)`,
        [reservationId, request.tenantId, request.orderId, request.suborderId,
          request.merchantId, request.branchId, request.idempotencyKey,
          request.requestedAtUtc, request.expiresAtUtc ?? null]
      );

      for (const line of request.lines) {
        const inventoryRow = stockByVariant.get(line.productVariantId);
        if (!inventoryRow) throw new Error("inventory_reservation_stock_mapping_missing");
        const changed = await client.query(
          `UPDATE branch_inventory
           SET reserved_quantity = reserved_quantity + $4, updated_at = $5
           WHERE merchant_id = $1 AND branch_id = $2 AND product_variant_id = $3
             AND sku = $6 AND available_quantity - reserved_quantity >= $4`,
          [request.merchantId, request.branchId, inventoryRow.product_variant_id, line.quantity,
            request.requestedAtUtc, line.sku]
        );
        if (changed.rowCount !== 1) throw new Error("inventory_reservation_stock_race");
        await client.query(
          `INSERT INTO inventory_reservation_lines
           (reservation_id, merchant_id, branch_id, product_variant_id, sku, quantity, catalog_variant_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [reservationId, request.merchantId, request.branchId,
            inventoryRow.product_variant_id, line.sku, line.quantity, line.productVariantId]
        );
      }

      await client.query("COMMIT");
      return { outcome: "reserved", reservationReference: reservationId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
