import { randomUUID } from "node:crypto";
import type { InventoryReservationRequest, InventoryReservationReleaseResult } from "./inventory-reservation.js";
import { PostgresBranchInventoryReservationLifecycle } from "./postgres-branch-inventory-reservation-lifecycle.js";
import type { PostgresPool } from "./postgres-iam-store.js";

export interface ExternalInventoryReservationEvidenceInput {
  request: InventoryReservationRequest;
  providerKey: string;
  providerReservationReference: string;
  expiresAtUtc: string;
}

export interface ExternalInventoryReservationEvidenceStore {
  record(input: ExternalInventoryReservationEvidenceInput): Promise<{ reservationId: string; expiresAtUtc: string }>;
  release(
    input: {
      request: InventoryReservationRequest;
      reservationId: string;
      releasedAtUtc: string;
    },
    releaseProvider: (evidence: { providerKey: string; providerReservationReference: string }, releasedAtUtc: string) =>
      Promise<InventoryReservationReleaseResult>
  ): Promise<InventoryReservationReleaseResult>;
}

/**
 * Mirrors a provider-confirmed hard hold into the platform ledger in one transaction.
 * It deliberately does not invent a hold: callers must supply a verified provider receipt.
 */
export class PostgresExternalInventoryReservationEvidenceStore implements ExternalInventoryReservationEvidenceStore {
  private readonly lifecycle: PostgresBranchInventoryReservationLifecycle;

  constructor(
    private readonly pool: PostgresPool,
    private readonly createId: () => string = randomUUID
  ) {
    this.lifecycle = new PostgresBranchInventoryReservationLifecycle(pool);
  }

  async release(
    input: {
      request: InventoryReservationRequest;
      reservationId: string;
      releasedAtUtc: string;
    },
    releaseProvider: (evidence: { providerKey: string; providerReservationReference: string }) =>
      Promise<InventoryReservationReleaseResult>
  ): Promise<InventoryReservationReleaseResult> {
    const request = input.request;
    if (!request.providerIntegrationId?.trim() || !input.reservationId.trim() ||
        !Number.isFinite(Date.parse(input.releasedAtUtc)) ||
        new Date(input.releasedAtUtc).toISOString() !== input.releasedAtUtc) {
      return { outcome: "unsupported" };
    }
    const evidence = await this.pool.query<{
      provider_key: string;
      provider_reservation_reference: string;
      status: string;
    }>(
      `SELECT e.provider_key,e.provider_reservation_reference,r.status
       FROM inventory_provider_reservation_evidence e
       JOIN inventory_reservations r
         ON r.tenant_id=e.tenant_id AND r.id=e.reservation_id
       WHERE e.tenant_id=$1 AND e.reservation_id=$2
         AND e.integration_id=$3 AND r.order_id=$4 AND r.suborder_id=$5
         AND r.merchant_id=$6 AND r.branch_id=$7`,
      [request.tenantId,input.reservationId,request.providerIntegrationId,
        request.orderId,request.suborderId,request.merchantId,request.branchId]
    );
    if (evidence.rowCount !== 1) return { outcome: "unsupported" };
    const row = evidence.rows[0]!;
    if (row.status === "released") return { outcome: "already_released" };
    if (row.status !== "reserved") return { outcome: "unsupported" };

    // The reservation id and order scope are not enough on their own: the
    // compensation payload must also match the exact persisted variant/SKU/
    // quantity set before the external provider is asked to release the hold.
    const persistedLines = await this.pool.query<{
      catalog_variant_id: string; sku: string; quantity: number;
    }>(
      `SELECT catalog_variant_id,sku,quantity
       FROM inventory_reservation_lines
       WHERE reservation_id=$1
       ORDER BY catalog_variant_id`,
      [input.reservationId]
    );
    const expectedLines = [...request.lines].sort((a,b) =>
      a.productVariantId.localeCompare(b.productVariantId)
    );
    if (persistedLines.rows.length !== expectedLines.length ||
        persistedLines.rows.some((line,index) =>
          line.catalog_variant_id !== expectedLines[index]?.productVariantId ||
          line.sku !== expectedLines[index]?.sku ||
          line.quantity !== expectedLines[index]?.quantity
        )) {
      return { outcome: "unsupported" };
    }

    // Persist the first release timestamp before contacting the provider. The
    // provider idempotency key and timestamp together define the exact release
    // payload; retries must not generate a new timestamp after a timeout/crash.
    await this.pool.query(
      `INSERT INTO inventory_provider_reservation_release_intents
         (tenant_id,reservation_id,integration_id,released_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id,reservation_id) DO NOTHING`,
      [request.tenantId,input.reservationId,request.providerIntegrationId,input.releasedAtUtc]
    );
    const releaseIntent = await this.pool.query<{
      integration_id: string; released_at: Date | string;
    }>(
      `SELECT integration_id,released_at
       FROM inventory_provider_reservation_release_intents
       WHERE tenant_id=$1 AND reservation_id=$2`,
      [request.tenantId,input.reservationId]
    );
    if (releaseIntent.rowCount !== 1 ||
        releaseIntent.rows[0]!.integration_id !== request.providerIntegrationId) {
      return { outcome: "unsupported" };
    }
    const stableReleasedAtUtc = new Date(releaseIntent.rows[0]!.released_at).toISOString();

    // Provider release is deliberately performed before local ledger release.
    // If the process crashes between them, the next attempt reuses the durable
    // timestamp and idempotency key, then completes the local compare-and-swap.
    const providerResult = await releaseProvider({
      providerKey: row.provider_key,
      providerReservationReference: row.provider_reservation_reference
    }, stableReleasedAtUtc);
    if (providerResult.outcome === "unsupported") return providerResult;
    const local = await this.lifecycle.release({
      tenantId: request.tenantId,
      merchantId: request.merchantId,
      branchId: request.branchId,
      reservationId: input.reservationId,
      nowUtc: input.releasedAtUtc,
      reason: "external_provider_reservation_released"
    });
    if (local.outcome === "not_found") return { outcome: "unsupported" };
    if (local.outcome === "already_finalized" && local.status !== "released") {
      return { outcome: "unsupported" };
    }
    return local.outcome === "already_finalized"
      ? { outcome: "already_released" }
      : { outcome: "released" };
  }

  async record(input: ExternalInventoryReservationEvidenceInput): Promise<{ reservationId: string; expiresAtUtc: string }> {
    const request = input.request;
    const integrationId = request.providerIntegrationId;
    const expiresAt = Date.parse(input.expiresAtUtc);
    if (!integrationId?.trim() || !input.providerKey.trim() ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test(input.providerReservationReference) ||
        !Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== input.expiresAtUtc ||
        expiresAt <= Date.parse(request.requestedAtUtc)) {
      throw new Error("external_inventory_reservation_evidence_invalid");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [request.idempotencyKey]);

      const existing = await client.query<{
        id: string; tenant_id: string; order_id: string; suborder_id: string; expires_at: Date | string;
        merchant_id: string; branch_id: string; status: string;
        integration_id: string; provider_key: string; provider_reservation_reference: string;
      }>(
        `SELECT r.id,r.tenant_id,r.order_id,r.suborder_id,r.merchant_id,r.branch_id,r.status,
                e.integration_id,e.provider_key,e.provider_reservation_reference,e.expires_at
         FROM inventory_reservations r
         JOIN inventory_provider_reservation_evidence e
           ON e.tenant_id=r.tenant_id AND e.reservation_id=r.id
         WHERE r.idempotency_key=$1
         FOR UPDATE OF r,e`,
        [request.idempotencyKey]
      );
      if (existing.rowCount) {
        const row = existing.rows[0]!;
        const matches = row.tenant_id === request.tenantId && row.order_id === request.orderId &&
          row.suborder_id === request.suborderId && row.merchant_id === request.merchantId &&
          row.branch_id === request.branchId && row.integration_id === integrationId &&
          row.provider_key === input.providerKey &&
          row.provider_reservation_reference === input.providerReservationReference &&
          new Date(row.expires_at).toISOString() === input.expiresAtUtc &&
          row.status === "reserved";
        if (!matches) throw new Error("external_inventory_reservation_idempotency_conflict");
        const lines = await client.query<{ catalog_variant_id: string; sku: string; quantity: number }>(
          "SELECT catalog_variant_id,sku,quantity FROM inventory_reservation_lines WHERE reservation_id=$1 ORDER BY catalog_variant_id",
          [row.id]
        );
        const expected = [...request.lines].sort((a,b) => a.productVariantId.localeCompare(b.productVariantId));
        if (lines.rows.length !== expected.length || lines.rows.some((line,index) =>
          line.catalog_variant_id !== expected[index]?.productVariantId ||
          line.sku !== expected[index]?.sku || line.quantity !== expected[index]?.quantity)) {
          throw new Error("external_inventory_reservation_lines_conflict");
        }
        await client.query("COMMIT");
        return { reservationId: row.id, expiresAtUtc: new Date(row.expires_at).toISOString() };
      }

      const eligible = await client.query<{ id: string }>(
        `SELECT i.id
         FROM tenant_integrations i
         JOIN merchant_inventory_provider_branch_scopes s
           ON s.tenant_id=i.tenant_id AND s.integration_id=i.id
         JOIN merchants m ON m.tenant_id=i.tenant_id AND m.id=s.merchant_id
         JOIN merchant_branches b ON b.merchant_id=s.merchant_id AND b.id=s.branch_id
         WHERE i.tenant_id=$1 AND i.id=$2 AND i.provider_key=$3
           AND i.family IN ('pos','erp') AND i.status='connected'
           AND i.capabilities @> '["inventory.hard_reservation"]'::jsonb
           AND s.active=true AND s.merchant_id=$4 AND s.branch_id=$5
           AND m.status='active' AND b.status='active'
         FOR UPDATE OF i,s,m,b`,
        [request.tenantId, integrationId, input.providerKey, request.merchantId, request.branchId]
      );
      if (eligible.rowCount !== 1) throw new Error("external_inventory_reservation_scope_revoked");

      const order = await client.query<{ id: string }>(
        `SELECT s.id
         FROM merchant_suborders s
         JOIN customer_orders o ON o.id=s.order_id
         WHERE s.tenant_id=$1 AND s.order_id=$2 AND s.id=$3
           AND s.merchant_id=$4 AND s.branch_id=$5
           AND o.status='awaiting_payment'
           AND EXISTS (
             SELECT 1 FROM verified_order_payment_captures p
             WHERE p.tenant_id=o.tenant_id AND p.order_id=o.id
               AND p.amount_minor=o.total_minor AND p.currency=o.currency
           )
         FOR UPDATE OF s`,
        [request.tenantId, request.orderId, request.suborderId, request.merchantId, request.branchId]
      );
      if (order.rowCount !== 1) throw new Error("external_inventory_reservation_paid_order_not_found");

      const stock = await client.query<{
        catalog_variant_id: string; external_variant_id: string; sku: string; order_quantity: number;
      }>(
        `SELECT oi.product_variant_id AS catalog_variant_id,
                i.product_variant_id AS external_variant_id, i.sku,
                oi.quantity AS order_quantity
         FROM customer_order_items oi
         JOIN commerce_catalog_variants v
           ON v.tenant_id=oi.tenant_id AND v.id=oi.product_variant_id
         JOIN branch_inventory i
           ON i.merchant_id=oi.merchant_id AND i.branch_id=oi.branch_id
          AND i.product_variant_id=COALESCE(v.external_variant_id,oi.product_variant_id)
          AND i.sku=oi.sku
         WHERE oi.tenant_id=$1 AND oi.order_id=$2 AND oi.suborder_id=$3
           AND oi.merchant_id=$4 AND oi.branch_id=$5
         ORDER BY oi.product_variant_id
         FOR UPDATE OF i`,
        [request.tenantId, request.orderId, request.suborderId, request.merchantId, request.branchId]
      );
      const expected = [...request.lines].sort((a,b) => a.productVariantId.localeCompare(b.productVariantId));
      if (stock.rows.length !== expected.length || stock.rows.some((line,index) =>
        line.catalog_variant_id !== expected[index]?.productVariantId ||
        line.sku !== expected[index]?.sku || line.order_quantity !== expected[index]?.quantity)) {
        throw new Error("external_inventory_reservation_catalog_mapping_mismatch");
      }

      const reservationId = this.createId();
      await client.query(
        `INSERT INTO inventory_reservations
         (id,tenant_id,order_id,suborder_id,merchant_id,branch_id,idempotency_key,status,requested_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9)`,
        [reservationId,request.tenantId,request.orderId,request.suborderId,request.merchantId,
          request.branchId,request.idempotencyKey,request.requestedAtUtc,input.expiresAtUtc]
      );
      await client.query(
        `INSERT INTO inventory_provider_reservation_evidence
         (tenant_id,reservation_id,integration_id,provider_key,provider_reservation_reference,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [request.tenantId,reservationId,integrationId,input.providerKey,
          input.providerReservationReference,input.expiresAtUtc]
      );

      for (const line of expected) {
        const mapping = stock.rows.find(row => row.catalog_variant_id === line.productVariantId)!;
        const updated = await client.query(
          `UPDATE branch_inventory
           SET reserved_quantity=reserved_quantity+$4,updated_at=$5
           WHERE merchant_id=$1 AND branch_id=$2 AND product_variant_id=$3 AND sku=$6`,
          [request.merchantId,request.branchId,mapping.external_variant_id,line.quantity,
            request.requestedAtUtc,line.sku]
        );
        if (updated.rowCount !== 1) throw new Error("external_inventory_reservation_ledger_update_failed");
        await client.query(
          `INSERT INTO inventory_reservation_lines
           (reservation_id,merchant_id,branch_id,product_variant_id,sku,quantity,catalog_variant_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [reservationId,request.merchantId,request.branchId,mapping.external_variant_id,
            line.sku,line.quantity,line.productVariantId]
        );
      }

      await client.query("COMMIT");
      return { reservationId, expiresAtUtc: input.expiresAtUtc };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
