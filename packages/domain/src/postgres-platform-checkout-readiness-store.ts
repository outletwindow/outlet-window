import type { AuditEvent } from "./audit.js";
import { PostgresAuditEventStore } from "./postgres-audit-event-store.js";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";

type LockedOrder = {
  id: string; customer_id: string; status: string; version: number; currency: string;
  total_minor: string | number; metadata: unknown;
  delivery_destination: unknown; delivery_quote: unknown; delivery_zone_id: string | null;
  delivery_branch_id: string | null;
};
type LockedSuborder = {
  id: string; tenant_id: string; merchant_id: string; branch_id: string;
  status: string; version: number;
};
type ItemTotals = { suborder_id: string; item_count: number; subtotal_minor: string | number };
type LockedSuborderDeliveryQuote = {
  id: string; tenant_id: string; order_id: string; suborder_id: string;
  merchant_id: string; branch_id: string; service_area_id: string;
  currency: string; total_minor: string | number;
  created_at: Date | string; expires_at: Date | string; quote_snapshot: unknown;
};

export type PlatformCheckoutReadinessResult =
  | { outcome: "ready"; orderId: string; suborderIds: readonly string[]; parentVersion: number }
  | { outcome: "not_found" | "conflict" | "invalid_snapshot" | "audit_mismatch" };

function validObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pricingSnapshotMatches(input: {
  metadata: unknown; currency: string; totalMinor: string | number;
  itemSubtotal: number; deliveryMinor: number; deliveryQuoteId: string;
  deliveryRuleId: string; deliveryRuleVersion: number; deliveryQuoteCount: number;
}): boolean {
  if (!validObject(input.metadata) || !validObject(input.metadata.checkoutPricing)) return false;
  const pricing = input.metadata.checkoutPricing;
  if (pricing.currency !== input.currency ||
      pricing.deliveryQuoteId !== input.deliveryQuoteId ||
      pricing.deliveryRuleId !== input.deliveryRuleId ||
      pricing.deliveryRuleVersion !== input.deliveryRuleVersion ||
      !Array.isArray(pricing.components)) return false;
  let subtotal = 0;
  let productSubtotalCount = 0;
  let deliveryCount = 0;
  let deliverySubtotal = 0;
  let discountComponents = 0;
  for (const component of pricing.components) {
    if (!validObject(component) || typeof component.kind !== "string" ||
        typeof component.label !== "string" || !component.label.trim() ||
        !Number.isSafeInteger(component.amountMinor) || (component.amountMinor as number) < 0 ||
        !["product_subtotal", "delivery", "collection", "platform_fee", "packaging", "tax", "discount"].includes(component.kind)) {
      return false;
    }
    const amount = component.amountMinor as number;
    if (component.kind === "discount") {
      discountComponents += amount;
      if (!Number.isSafeInteger(discountComponents)) return false;
    } else {
      subtotal += amount;
      if (!Number.isSafeInteger(subtotal)) return false;
    }
    if (component.kind === "product_subtotal") {
      productSubtotalCount += 1;
      if (amount !== input.itemSubtotal) return false;
    }
    if (component.kind === "delivery") {
      deliveryCount += 1;
      deliverySubtotal += amount;
      if (!Number.isSafeInteger(deliverySubtotal)) return false;
    }
  }
  const deliveryQuotes = pricing.deliveryQuotes;
  if (!Array.isArray(deliveryQuotes) || deliveryQuotes.length !== input.deliveryQuoteCount) return false;
  const deliveryComponents = pricing.components.filter(component =>
    validObject(component) && component.kind === "delivery");
  const seenQuoteKeys = new Set<string>();
  for (const entry of deliveryQuotes) {
    if (!validObject(entry) || typeof entry.merchantId !== "string" ||
        typeof entry.branchId !== "string" || typeof entry.quoteId !== "string" ||
        !Number.isSafeInteger(entry.totalMinor)) return false;
    const key = entry.merchantId + ":" + entry.branchId;
    if (seenQuoteKeys.has(key)) return false;
    seenQuoteKeys.add(key);
    const component = deliveryComponents.find(candidate =>
      validObject(candidate) && candidate.quoteId === entry.quoteId &&
      candidate.suborderKey === key && candidate.amountMinor === entry.totalMinor);
    if (!component) return false;
  }
  const discount = pricing.discountMinor === undefined ? 0 : pricing.discountMinor;
  const storedTotal = Number(input.totalMinor);
  return productSubtotalCount === 1 && deliveryCount === input.deliveryQuoteCount &&
    deliverySubtotal === input.deliveryMinor &&
    typeof discount === "number" && Number.isSafeInteger(discount) &&
    discount >= 0 && discount <= subtotal &&
    discountComponents === discount &&
    Number.isSafeInteger(storedTotal) && storedTotal >= 0 &&
    subtotal - discount === storedTotal;
}

/**
 * Platform-owned, all-or-nothing transition from pending_validation to awaiting_payment.
 * It is deliberately separate from merchant transition APIs: every merchant suborder,
 * the parent order, and its audit evidence commit in one PostgreSQL transaction.
 */
export class PostgresPlatformCheckoutReadinessStore {
  constructor(private readonly pool: PostgresPool) {}

  async transitionToAwaitingPayment(input: {
    orderId: string; customerId: string; expectedVersion: number; actorId: string;
    actorRole: "customer" | "platform_user" | "system"; occurredAt: string; auditEvents: readonly AuditEvent[];
  }): Promise<PlatformCheckoutReadinessResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.transitionToAwaitingPaymentInTransaction(input, client);
      if (result.outcome === "ready") await client.query("COMMIT");
      else await client.query("ROLLBACK");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Runs readiness validation and transition in a caller-owned transaction.
   * Caller must roll back on any non-ready outcome; this method never controls
   * transaction lifecycle or releases the supplied client.
   */
  async transitionToAwaitingPaymentInTransaction(input: {
    orderId: string; customerId: string; expectedVersion: number; actorId: string;
    actorRole: "customer" | "platform_user" | "system"; occurredAt: string; auditEvents: readonly AuditEvent[];
  }, client: PostgresClient): Promise<PlatformCheckoutReadinessResult> {
    const occurredAt = Date.parse(input.occurredAt);
    if (!input.orderId.trim() || !input.customerId.trim() || !input.actorId.trim() ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
        !Number.isFinite(occurredAt)) throw new Error("INVALID_PLATFORM_CHECKOUT_READINESS_INPUT");

      const parentResult = await client.query<LockedOrder>(
        `SELECT id, customer_id, status, version, currency, total_minor, metadata,
                delivery_destination, delivery_quote, delivery_zone_id, delivery_branch_id
         FROM customer_orders
         WHERE id = $1 AND tenant_id = 'platform' AND customer_id = $2
         FOR UPDATE`,
        [input.orderId, input.customerId]
      );
      if (parentResult.rowCount !== 1 || !parentResult.rows[0]) {
        return { outcome: "not_found" };
      }
      const parent = parentResult.rows[0];
      if (parent.status !== "pending_validation" || parent.version !== input.expectedVersion) {
        return { outcome: "conflict" };
      }

      // Lock every merchant row in deterministic order to avoid partial readiness and
      // reduce deadlock risk when multiple checkout workers contend for the same order.
      const subordersResult = await client.query<LockedSuborder>(
        `SELECT id, tenant_id, merchant_id, branch_id, status, version
         FROM merchant_suborders WHERE order_id = $1
         ORDER BY id FOR UPDATE`,
        [input.orderId]
      );
      const suborders = subordersResult.rows;
      if (suborders.length === 0 || suborders.some(row => row.status !== "pending_validation")) {
        return { outcome: "conflict" };
      }

      const destination = parent.delivery_destination;
      const quote = parent.delivery_quote;
      if (!validObject(destination) || !validObject(quote) ||
          !parent.delivery_zone_id?.trim() ||
          typeof quote.quoteId !== "string" || !quote.quoteId.trim() ||
          typeof quote.ruleId !== "string" || !quote.ruleId.trim() ||
          !Number.isSafeInteger(quote.ruleVersion) || (quote.ruleVersion as number) < 1 ||
          quote.currency !== parent.currency ||
          !Number.isSafeInteger(quote.totalMinor) || (quote.totalMinor as number) < 0 ||
          typeof quote.createdAtUtc !== "string" || typeof quote.expiresAtUtc !== "string" ||
          !Number.isFinite(Date.parse(quote.createdAtUtc)) ||
          !Number.isFinite(Date.parse(quote.expiresAtUtc)) ||
          Date.parse(quote.createdAtUtc) > occurredAt || Date.parse(quote.expiresAtUtc) <= occurredAt) {
        return { outcome: "invalid_snapshot" };
      }

      const deliveryQuotesResult = await client.query<LockedSuborderDeliveryQuote>(
        `SELECT id,tenant_id,order_id,suborder_id,merchant_id,branch_id,service_area_id,
                currency,total_minor,created_at,expires_at,quote_snapshot
         FROM customer_order_suborder_delivery_quotes
         WHERE order_id=$1
         ORDER BY suborder_id FOR SHARE`,
        [input.orderId]
      );
      const deliveryQuotes = deliveryQuotesResult.rows;
      if (deliveryQuotes.length !== suborders.length) return { outcome: "invalid_snapshot" };
      const quoteBySuborder = new Map(deliveryQuotes.map(row => [row.suborder_id, row]));
      const timestamp = (value: Date | string): number =>
        value instanceof Date ? value.getTime() : Date.parse(value);
      let deliveryTotalMinor = 0;
      for (const suborder of suborders) {
        const ledger = quoteBySuborder.get(suborder.id);
        const snapshot = ledger?.quote_snapshot;
        if (!ledger || ledger.tenant_id !== suborder.tenant_id ||
            ledger.order_id !== input.orderId || ledger.merchant_id !== suborder.merchant_id ||
            ledger.branch_id !== suborder.branch_id || ledger.service_area_id !== parent.delivery_zone_id ||
            ledger.currency !== parent.currency ||
            !Number.isSafeInteger(Number(ledger.total_minor)) || Number(ledger.total_minor) < 0 ||
            !validObject(snapshot) || snapshot.quoteId !== ledger.id ||
            snapshot.currency !== parent.currency || snapshot.totalMinor !== Number(ledger.total_minor) ||
            typeof snapshot.ruleId !== "string" || !snapshot.ruleId.trim() ||
            !Number.isSafeInteger(snapshot.ruleVersion) ||
            typeof snapshot.createdAtUtc !== "string" || typeof snapshot.expiresAtUtc !== "string" ||
            snapshot.createdAtUtc !== (ledger.created_at instanceof Date ? ledger.created_at.toISOString() : new Date(ledger.created_at).toISOString()) ||
            snapshot.expiresAtUtc !== (ledger.expires_at instanceof Date ? ledger.expires_at.toISOString() : new Date(ledger.expires_at).toISOString()) ||
            timestamp(ledger.created_at) > occurredAt || timestamp(ledger.expires_at) <= occurredAt) {
          return { outcome: "invalid_snapshot" };
        }
        deliveryTotalMinor += Number(ledger.total_minor);
        if (!Number.isSafeInteger(deliveryTotalMinor)) return { outcome: "invalid_snapshot" };
      }
      const parentQuoteLedger = deliveryQuotes.find(row => row.id === quote.quoteId);
      const parentQuoteSnapshot = parentQuoteLedger?.quote_snapshot;
      if (!parentQuoteLedger || !validObject(parentQuoteSnapshot) ||
          parent.delivery_branch_id !== parentQuoteLedger.branch_id ||
          quote.ruleId !== parentQuoteSnapshot.ruleId ||
          quote.ruleVersion !== parentQuoteSnapshot.ruleVersion ||
          quote.totalMinor !== parentQuoteSnapshot.totalMinor ||
          quote.createdAtUtc !== parentQuoteSnapshot.createdAtUtc ||
          quote.expiresAtUtc !== parentQuoteSnapshot.expiresAtUtc) {
        return { outcome: "invalid_snapshot" };
      }

      const totals = await client.query<ItemTotals>(
        `SELECT s.id AS suborder_id, COUNT(i.id)::int AS item_count,
                COALESCE(SUM(i.quantity::numeric * i.unit_price_minor::numeric), 0)::text AS subtotal_minor
         FROM merchant_suborders s
         LEFT JOIN customer_order_items i
           ON i.order_id = s.order_id AND i.suborder_id = s.id
         WHERE s.order_id = $1
         GROUP BY s.id ORDER BY s.id`,
        [input.orderId]
      );
      if (totals.rows.length !== suborders.length || totals.rows.some((row, index) => {
        const suborder = suborders[index];
        return !suborder || row.suborder_id !== suborder.id ||
          !Number.isSafeInteger(Number(row.item_count)) || Number(row.item_count) < 1 ||
          !Number.isSafeInteger(Number(row.subtotal_minor)) ||
          Number(row.subtotal_minor) < 0;
      })) {
        return { outcome: "invalid_snapshot" };
      }
      // Compare each calculated line total with its persisted merchant subtotal.
      const subtotalRows = await client.query<{ id: string; subtotal_minor: string | number }>(
        "SELECT id, subtotal_minor FROM merchant_suborders WHERE order_id = $1 ORDER BY id",
        [input.orderId]
      );
      if (subtotalRows.rows.length !== totals.rows.length ||
          totals.rows.some((row, index) =>
            String(row.subtotal_minor) !== String(subtotalRows.rows[index]?.subtotal_minor))) {
        return { outcome: "invalid_snapshot" };
      }

      const itemSubtotal = totals.rows.reduce((sum, row) => sum + Number(row.subtotal_minor), 0);
      if (!Number.isSafeInteger(itemSubtotal) || !validObject(parent.metadata) ||
          !validObject(parent.metadata.checkoutPricing)) {
        return { outcome: "invalid_snapshot" };
      }
      const pricing = parent.metadata.checkoutPricing;
      const pricingDeliveryQuotes = pricing.deliveryQuotes;
      if (!Array.isArray(pricingDeliveryQuotes) || pricingDeliveryQuotes.length !== deliveryQuotes.length ||
          pricingDeliveryQuotes.some(entry => {
            if (!validObject(entry)) return true;
            const ledger = deliveryQuotes.find(row => row.suborder_id === suborders.find(sub =>
              sub.merchant_id === entry.merchantId && sub.branch_id === entry.branchId)?.id);
            return !ledger || entry.quoteId !== ledger.id || entry.ruleId !== (validObject(ledger.quote_snapshot) ? ledger.quote_snapshot.ruleId : undefined) ||
              entry.ruleVersion !== (validObject(ledger.quote_snapshot) ? ledger.quote_snapshot.ruleVersion : undefined) ||
              entry.totalMinor !== Number(ledger.total_minor);
          }) ||
          !pricingSnapshotMatches({
            metadata: parent.metadata, currency: parent.currency, totalMinor: parent.total_minor,
            itemSubtotal, deliveryMinor: deliveryTotalMinor,
            deliveryQuoteId: quote.quoteId as string, deliveryRuleId: quote.ruleId as string,
            deliveryRuleVersion: quote.ruleVersion as number, deliveryQuoteCount: deliveryQuotes.length
          })) {
        return { outcome: "invalid_snapshot" };
      }

      const eventsBySuborder = new Map<string, AuditEvent>();
      for (const event of input.auditEvents) {
        if (!event.resourceId || eventsBySuborder.has(event.resourceId)) {
            return { outcome: "audit_mismatch" };
        }
        eventsBySuborder.set(event.resourceId, event);
      }
      if (eventsBySuborder.size !== suborders.length || suborders.some(suborder => {
        const event = eventsBySuborder.get(suborder.id);
        return !event || event.tenantId !== suborder.tenant_id ||
          event.merchantId !== suborder.merchant_id || event.branchId !== suborder.branch_id ||
          event.actor.id !== input.actorId || event.actor.type !== input.actorRole ||
          event.occurredAt !== input.occurredAt ||
          event.action !== "order.suborder.transition" || event.outcome !== "success" ||
          event.resourceType !== "merchant_suborder" ||
          event.metadata.orderId !== input.orderId ||
          event.metadata.previousStatus !== "pending_validation" ||
          event.metadata.nextStatus !== "awaiting_payment";
      })) {
        return { outcome: "audit_mismatch" };
      }

      const changedSuborders = await client.query<{ id: string }>(
        `UPDATE merchant_suborders
         SET status = 'awaiting_payment', version = version + 1, updated_at = $2
         WHERE order_id = $1 AND status = 'pending_validation'
         RETURNING id`,
        [input.orderId, input.occurredAt]
      );
      if (changedSuborders.rowCount !== suborders.length) {
        return { outcome: "conflict" };
      }
      const changedParent = await client.query(
        `UPDATE customer_orders
         SET status = 'awaiting_payment', version = version + 1, updated_at = $3
         WHERE id = $1 AND tenant_id = 'platform' AND customer_id = $2
           AND status = 'pending_validation' AND version = $4`,
        [input.orderId, input.customerId, input.occurredAt, input.expectedVersion]
      );
      if (changedParent.rowCount !== 1) {
        return { outcome: "conflict" };
      }

      const auditStore = new PostgresAuditEventStore(client);
      for (const suborder of suborders) {
        const event = eventsBySuborder.get(suborder.id)!;
        const persisted = await auditStore.append(event);
        if (persisted !== "inserted") {
            return { outcome: "audit_mismatch" };
        }
      }
      return {
        outcome: "ready", orderId: input.orderId,
        suborderIds: suborders.map(row => row.id),
        parentVersion: input.expectedVersion + 1
      };
  }
}