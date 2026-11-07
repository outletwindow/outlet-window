import type { PostgresPool } from "./postgres-iam-store.js";

export type InventoryReservationFinalState = "released" | "expired" | "consumed";
export type InventoryReservationFinalizeResult =
  | { outcome: "updated"; status: InventoryReservationFinalState }
  | { outcome: "already_finalized"; status: InventoryReservationFinalState }
  | { outcome: "not_found" };

/**
 * Releases or consumes an existing reservation exactly once.
 * A release returns the allocation to available stock; consumption reduces both
 * available and reserved quantities. This repository never captures or refunds payment.
 */
export class PostgresBranchInventoryReservationLifecycle {
  constructor(private readonly pool: PostgresPool) {}

  release(input: {
    tenantId: string;
    reservationId: string;
    nowUtc: string;
  }): Promise<InventoryReservationFinalizeResult> {
    return this.finalize({ ...input, nextStatus: "released" });
  }

  expire(input: {
    tenantId: string;
    reservationId: string;
    nowUtc: string;
  }): Promise<InventoryReservationFinalizeResult> {
    return this.finalize({ ...input, nextStatus: "expired" });
  }

  consume(input: {
    tenantId: string;
    reservationId: string;
    nowUtc: string;
  }): Promise<InventoryReservationFinalizeResult> {
    return this.finalize({ ...input, nextStatus: "consumed" });
  }

  private async finalize(input: {
    tenantId: string;
    reservationId: string;
    nowUtc: string;
    nextStatus: InventoryReservationFinalState;
  }): Promise<InventoryReservationFinalizeResult> {
    const now = Date.parse(input.nowUtc);
    if (!input.tenantId.trim() || !input.reservationId.trim() || !Number.isFinite(now)) {
      throw new Error("inventory_reservation_finalize_invalid_input");
    }
    const nowUtc = new Date(now).toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        id: string; status: InventoryReservationFinalState | "reserved";
        expires_at: Date | string | null;
      }>(
        `SELECT id, status, expires_at
         FROM inventory_reservations
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [input.tenantId, input.reservationId]
      );
      if (!locked.rowCount) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      const reservation = locked.rows[0]!;
      if (reservation.status !== "reserved") {
        await client.query("COMMIT");
        return { outcome: "already_finalized", status: reservation.status };
      }
      const expiresAt = reservation.expires_at === null
        ? null : new Date(reservation.expires_at).getTime();
      if (input.nextStatus === "expired" && (expiresAt === null || expiresAt > now)) {
        throw new Error("inventory_reservation_not_expired");
      }
      if (input.nextStatus === "consumed" && expiresAt !== null && expiresAt <= now) {
        throw new Error("inventory_reservation_expired");
      }

      const lines = await client.query<{
        merchant_id: string; branch_id: string; product_variant_id: string; quantity: number;
      }>(
        `SELECT merchant_id, branch_id, product_variant_id, quantity
         FROM inventory_reservation_lines
         WHERE reservation_id = $1
         ORDER BY merchant_id, branch_id, product_variant_id`,
        [input.reservationId]
      );
      if (!lines.rowCount) throw new Error("inventory_reservation_lines_missing");

      const stock = await client.query<{
        product_variant_id: string; available_quantity: number; reserved_quantity: number;
      }>(
        `SELECT i.product_variant_id, i.available_quantity, i.reserved_quantity
         FROM branch_inventory i
         JOIN inventory_reservation_lines l
           ON l.merchant_id = i.merchant_id AND l.branch_id = i.branch_id
          AND l.product_variant_id = i.product_variant_id
         WHERE l.reservation_id = $1
         ORDER BY i.merchant_id, i.branch_id, i.product_variant_id
         FOR UPDATE OF i`,
        [input.reservationId]
      );
      if (stock.rowCount !== lines.rowCount) throw new Error("inventory_reservation_stock_missing");

      const stockByVariant = new Map(stock.rows.map(row => [row.product_variant_id, row]));
      for (const line of lines.rows) {
        const row = stockByVariant.get(line.product_variant_id);
        if (!row || row.reserved_quantity < line.quantity ||
            (input.nextStatus === "consumed" && row.available_quantity < line.quantity)) {
          throw new Error("inventory_reservation_stock_ledger_conflict");
        }
      }

      for (const line of lines.rows) {
        const consumed = input.nextStatus === "consumed" ? line.quantity : 0;
        const changed = await client.query(
          `UPDATE branch_inventory
           SET reserved_quantity = reserved_quantity - $4,
               available_quantity = available_quantity - $5,
               updated_at = $6
           WHERE merchant_id = $1 AND branch_id = $2 AND product_variant_id = $3
             AND reserved_quantity >= $4 AND available_quantity >= $5`,
          [line.merchant_id, line.branch_id, line.product_variant_id,
            line.quantity, consumed, nowUtc]
        );
        if (changed.rowCount !== 1) throw new Error("inventory_reservation_stock_ledger_conflict");
      }

      await client.query(
        "UPDATE inventory_reservations SET status = $3, updated_at = $4 WHERE tenant_id = $1 AND id = $2 AND status = 'reserved'",
        [input.tenantId, input.reservationId, input.nextStatus, nowUtc]
      );
      await client.query("COMMIT");
      return { outcome: "updated", status: input.nextStatus };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
