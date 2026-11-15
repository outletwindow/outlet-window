import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "./audit.js";
import type { PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresPlatformCheckoutReadinessStore } from "./postgres-platform-checkout-readiness-store.js";

const occurredAt = "2026-11-14T16:00:00.000Z";
const event = (id: string, suborderId: string, tenantId: string, merchantId: string, branchId: string): AuditEvent => ({
  id, schemaVersion: 1, type: "order.suborder.transitioned", category: "order_lifecycle",
  occurredAt, actor: { id: "platform-actor", type: "platform_user", role: "platform_checkout" },
  action: "order.suborder.transition", outcome: "success", resourceType: "merchant_suborder",
  resourceId: suborderId, tenantId, merchantId, branchId, correlationId: "request-1",
  source: "api", severity: "info",
  metadata: { orderId: "order-1", previousStatus: "pending_validation", nextStatus: "awaiting_payment" }
});

function database(options: { parentStatus?: string; version?: number; expiredQuote?: boolean; badOrderTotal?: boolean; discountWithoutComponent?: boolean } = {}) {
  const statements: string[] = [];
  const query = vi.fn(async <Row>(sql: string, values?: readonly unknown[]) => {
    statements.push(sql);
    let rows: unknown[] = [];
    let rowCount: number | null = 1;
    if (sql.includes("FROM customer_orders") && sql.includes("FOR UPDATE")) {
      rows = [{ id: "order-1", customer_id: "customer-1", status: options.parentStatus ?? "pending_validation",
        version: options.version ?? 4, currency: "SAR", total_minor: options.badOrderTotal ? "13501" : options.discountWithoutComponent ? "13000" : "13500",
        metadata: { checkoutPricing: { currency: "SAR", discountMinor: options.discountWithoutComponent ? 500 : 0, components: [
          { kind: "product_subtotal", amountMinor: 12000, label: "Products" },
          { kind: "delivery", amountMinor: 1500, label: "Delivery" }
        ] } }, delivery_destination: { city: "Jubail" },
        delivery_quote: { quoteId: "quote-1", ruleId: "rule-1", ruleVersion: 1, currency: "SAR",
          totalMinor: 1500, createdAtUtc: "2026-11-14T15:59:00.000Z",
          expiresAtUtc: options.expiredQuote ? "2026-11-14T15:59:30.000Z" : "2026-11-14T16:05:00.000Z" },
        delivery_zone_id: "zone-1", delivery_branch_id: "branch-1" }];
    } else if (sql.includes("FROM merchant_suborders") && sql.includes("ORDER BY id FOR UPDATE")) {
      rows = [
        { id: "sub-1", tenant_id: "merchant-tenant-1", merchant_id: "merchant-1", branch_id: "branch-1", status: "pending_validation", version: 1 },
        { id: "sub-2", tenant_id: "merchant-tenant-2", merchant_id: "merchant-2", branch_id: "branch-2", status: "pending_validation", version: 1 }
      ];
    } else if (sql.includes("COUNT(i.id)::int AS item_count")) {
      rows = [
        { suborder_id: "sub-1", item_count: 1, subtotal_minor: "5000" },
        { suborder_id: "sub-2", item_count: 2, subtotal_minor: "7000" }
      ];
    } else if (sql.includes("SELECT id, subtotal_minor FROM merchant_suborders")) {
      rows = [{ id: "sub-1", subtotal_minor: "5000" }, { id: "sub-2", subtotal_minor: "7000" }];
    } else if (sql.includes("UPDATE merchant_suborders") && sql.includes("RETURNING id")) {
      rows = [{ id: "sub-1" }, { id: "sub-2" }];
      rowCount = 2;
    } else if (sql.includes("INSERT INTO audit_events")) {
      rows = [{ id: "audit" }];
      rowCount = 1;
    } else if (sql.includes("UPDATE customer_orders")) {
      rowCount = 1;
    }
    return { rows: rows as Row[], rowCount } as PostgresQueryResult<Row>;
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as PostgresPool;
  return { pool, query, statements, client };
}

const baseInput = {
  orderId: "order-1", customerId: "customer-1", expectedVersion: 4,
  actorId: "platform-actor", actorRole: "platform_user" as const, occurredAt,
  auditEvents: [
    event("audit-1", "sub-1", "merchant-tenant-1", "merchant-1", "branch-1"),
    event("audit-2", "sub-2", "merchant-tenant-2", "merchant-2", "branch-2")
  ]
};

describe("PostgresPlatformCheckoutReadinessStore", () => {
  it("moves every merchant suborder and the platform parent atomically", async () => {
    const db = database();
    const result = await new PostgresPlatformCheckoutReadinessStore(db.pool).transitionToAwaitingPayment(baseInput);
    expect(result).toEqual({ outcome: "ready", orderId: "order-1", suborderIds: ["sub-1", "sub-2"], parentVersion: 5 });
    expect(db.statements[0]).toBe("BEGIN");
    expect(db.statements[1]).toContain("metadata");
    expect(db.statements.some(sql => sql.includes("tenant_id = 'platform'"))).toBe(true);
    expect(db.statements.some(sql => sql.includes("UPDATE merchant_suborders"))).toBe(true);
    expect(db.statements.some(sql => sql.includes("UPDATE customer_orders"))).toBe(true);
    expect(db.statements.filter(sql => sql.includes("INSERT INTO audit_events"))).toHaveLength(2);
    expect(db.statements.at(-1)).toBe("COMMIT");
    expect(db.client.release).toHaveBeenCalledOnce();
  });


  it("rejects a parent total that does not reconcile to the persisted pricing components", async () => {
    const db = database({ badOrderTotal: true });
    const result = await new PostgresPlatformCheckoutReadinessStore(db.pool).transitionToAwaitingPayment(baseInput);
    expect(result).toEqual({ outcome: "invalid_snapshot" });
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements.some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });

  it("rejects a discount amount that is missing from pricing components", async () => {
    const db = database({ discountWithoutComponent: true });
    const result = await new PostgresPlatformCheckoutReadinessStore(db.pool).transitionToAwaitingPayment(baseInput);
    expect(result).toEqual({ outcome: "invalid_snapshot" });
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements.some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });

  it("refuses an expired delivery quote before writing any state", async () => {
    const db = database({ expiredQuote: true });
    const result = await new PostgresPlatformCheckoutReadinessStore(db.pool).transitionToAwaitingPayment(baseInput);
    expect(result).toEqual({ outcome: "invalid_snapshot" });
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements.some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });

  it("refuses audit evidence that does not cover every exact merchant branch", async () => {
    const db = database();
    const input = { ...baseInput, auditEvents: [
      event("audit-1", "sub-1", "merchant-tenant-1", "merchant-1", "branch-1"),
      event("audit-2", "sub-2", "merchant-tenant-2", "merchant-2", "wrong-branch")
    ] };
    const result = await new PostgresPlatformCheckoutReadinessStore(db.pool).transitionToAwaitingPayment(input);
    expect(result).toEqual({ outcome: "audit_mismatch" });
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements.some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });

  it("does not retry an order with a stale parent version", async () => {
    const db = database({ version: 5 });
    const result = await new PostgresPlatformCheckoutReadinessStore(db.pool).transitionToAwaitingPayment(baseInput);
    expect(result).toEqual({ outcome: "conflict" });
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements.some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });
});
