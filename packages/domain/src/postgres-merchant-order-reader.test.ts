import { describe, expect, it, vi } from "vitest";
import { PostgresMerchantOrderReader } from "./postgres-merchant-order-reader.js";

describe("PostgresMerchantOrderReader", () => {
  it("queries only the authenticated merchant tenant and branch and maps the latest task", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rowCount: 1,
      rows: [{
        order_id: "order-1", suborder_id: "suborder-1", merchant_id: "merchant-1",
        branch_id: "branch-1", order_status: "confirmed", suborder_status: "ready_for_pickup",
        subtotal_minor: "12500", currency: "SAR", item_count: "2",
        created_at: "2026-11-22T06:00:00.000Z", task_id: "task-1",
        task_status: "arrived_at_pickup", task_version: 3
      }]
    }));
    const reader = new PostgresMerchantOrderReader({ query } as never);
    const result = await reader.listForBranch({
      tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1",
      status: "ready_for_pickup", limit: 25
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      "tenant-1", "merchant-1", "branch-1", "ready_for_pickup", 25
    ]);
    expect(result).toEqual([{
      orderId: "order-1", suborderId: "suborder-1", merchantId: "merchant-1",
      branchId: "branch-1", orderStatus: "confirmed", suborderStatus: "ready_for_pickup",
      subtotalMinor: 12500, currency: "SAR", itemCount: 2,
      createdAtUtc: "2026-11-22T06:00:00.000Z",
      task: { id: "task-1", status: "arrived_at_pickup", version: 3 }
    }]);
    expect(String(query.mock.calls[0]?.[0])).toContain("s.tenant_id = $1 AND s.merchant_id = $2 AND s.branch_id = $3");
  });

  it("caps limits and supports orders without a courier task", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rowCount: 1,
      rows: [{
        order_id: "order-2", suborder_id: "suborder-2", merchant_id: "merchant-1",
        branch_id: "branch-1", order_status: "preparing", suborder_status: "preparing",
        subtotal_minor: 500, currency: "SAR", item_count: 1,
        created_at: "2026-11-22T06:00:00.000Z", task_id: null,
        task_status: null, task_version: null
      }]
    }));
    const reader = new PostgresMerchantOrderReader({ query } as never);
    const result = await reader.listForBranch({
      tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1", limit: 1000
    });
    expect(query.mock.calls[0]?.[1]).toEqual(["tenant-1", "merchant-1", "branch-1", null, 100]);
    expect(result[0]?.task).toBeNull();
  });
});
