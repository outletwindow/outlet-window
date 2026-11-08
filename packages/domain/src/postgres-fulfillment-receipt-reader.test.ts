import { describe, expect, it } from "vitest";
import { PostgresFulfillmentReceiptReader } from "./postgres-fulfillment-receipt-reader.js";
import type { PostgresQueryable, PostgresQueryResult } from "./postgres-iam-store.js";

function fakeDb(rows: unknown[], capture: { sql?: string; values?: readonly unknown[] }): PostgresQueryable {
  return {
    async query<Row>(sql: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>> {
      capture.sql = sql;
      capture.values = values;
      return { rows: rows as Row[], rowCount: rows.length };
    }
  };
}

const row = {
  id: "inbox-1", tenant_id: "platform-1", order_id: "order-1",
  task_type: "merchant_preparation" as const, provider_reference: "merchant-job-42",
  processed_at: "2026-11-08T10:02:00.000Z", suborder_id: "suborder-1",
  merchant_tenant_id: "merchant-tenant-1", merchant_id: "merchant-1", branch_id: "branch-1"
};

describe("PostgresFulfillmentReceiptReader", () => {
  it("returns a receipt projection scoped to tenant and order", async () => {
    const capture: { sql?: string; values?: readonly unknown[] } = {};
    const reader = new PostgresFulfillmentReceiptReader(fakeDb([row], capture));
    expect(await reader.listForOrder({ tenantId: "platform-1", orderId: "order-1" })).toEqual([{
      inboxId: "inbox-1", tenantId: "platform-1", orderId: "order-1",
      suborderId: "suborder-1", merchantTenantId: "merchant-tenant-1",
      merchantId: "merchant-1", branchId: "branch-1", taskType: "merchant_preparation",
      providerReference: "merchant-job-42", acceptedAtUtc: "2026-11-08T10:02:00.000Z"
    }]);
    expect(capture.values).toEqual(["platform-1", "order-1", null]);
    expect(capture.sql).toContain("tenant_id = $1");
    expect(capture.sql).toContain("order_id = $2");
    expect(capture.sql).toContain("status = 'completed'");
    expect(capture.sql).toContain("provider_reference IS NOT NULL");
  });

  it("can restrict a lookup to one merchant suborder", async () => {
    const capture: { sql?: string; values?: readonly unknown[] } = {};
    const reader = new PostgresFulfillmentReceiptReader(fakeDb([], capture));
    expect(await reader.listForOrder({
      tenantId: "platform-1", orderId: "order-1", suborderId: "suborder-1"
    })).toEqual([]);
    expect(capture.values).toEqual(["platform-1", "order-1", "suborder-1"]);
  });

  it("rejects invalid scope identifiers before querying", async () => {
    let called = false;
    const db: PostgresQueryable = {
      async query<Row>(): Promise<PostgresQueryResult<Row>> {
        called = true;
        return { rows: [], rowCount: 0 };
      }
    };
    const reader = new PostgresFulfillmentReceiptReader(db);
    await expect(reader.listForOrder({ tenantId: " ", orderId: "order-1" })).rejects.toThrow("invalid_tenant_id");
    await expect(reader.listForOrder({ tenantId: "tenant", orderId: "x".repeat(201) })).rejects.toThrow("invalid_order_id");
    expect(called).toBe(false);
  });

  it("rejects incomplete persisted receipt projections", async () => {
    const reader = new PostgresFulfillmentReceiptReader(fakeDb([{ ...row, branch_id: null }], {}));
    await expect(reader.listForOrder({ tenantId: "platform-1", orderId: "order-1" }))
      .rejects.toThrow("invalid_fulfillment_receipt_row");
  });
});
