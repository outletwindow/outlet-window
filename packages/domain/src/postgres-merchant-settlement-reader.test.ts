import { describe, expect, it, vi } from "vitest";
import type { PostgresPool } from "./postgres-iam-store.js";
import { PostgresMerchantSettlementReader } from "./postgres-merchant-settlement-reader.js";

function readerFor(query: ReturnType<typeof vi.fn>) {
  const pool = { query } as unknown as PostgresPool;
  return new PostgresMerchantSettlementReader(pool);
}
const batchRow = {
  batch_id: "batch-1", merchant_id: "merchant-1", currency: "SAR",
  period_start: "2026-11-01T00:00:00.000Z", period_end: "2026-11-15T00:00:00.000Z",
  status: "approved" as const, created_at: "2026-11-15T00:00:00.000Z",
  approved_at: "2026-11-16T00:00:00.000Z",
  line_id: "line-1", order_id: "order-1", suborder_id: "suborder-1",
  branch_id: "branch-1", contract_reference: "contract-v1",
  gross_minor: "12000", deductions_minor: "1000", net_minor: "11000",
  deduction_breakdown: [{ code: "platform_fee", amountMinor: 1000 }]
};

describe("PostgresMerchantSettlementReader", () => {
  it("returns only the requested tenant and merchant batch with safe line amounts", async () => {
    const query = vi.fn(async () => ({ rows: [batchRow], rowCount: 1 }));
    await expect(readerFor(query).get({
      tenantId: "tenant-1", merchantId: "merchant-1", batchId: "batch-1"
    })).resolves.toEqual({
      id: "batch-1", merchantId: "merchant-1", currency: "SAR",
      periodStartUtc: "2026-11-01T00:00:00.000Z",
      periodEndUtc: "2026-11-15T00:00:00.000Z", status: "approved",
      createdAtUtc: "2026-11-15T00:00:00.000Z",
      approvedAtUtc: "2026-11-16T00:00:00.000Z",
      lines: [{
        id: "line-1", orderId: "order-1", suborderId: "suborder-1",
        branchId: "branch-1", contractReference: "contract-v1",
        grossMinor: 12000, deductionsMinor: 1000, netMinor: 11000,
        deductionBreakdown: [{ code: "platform_fee", amountMinor: 1000 }]
      }]
    });
    expect(query.mock.calls[0]?.[0]).toContain("b.tenant_id=$1 AND b.merchant_id=$2 AND b.id=$3");
    expect(query.mock.calls[0]?.[1]).toEqual(["tenant-1", "merchant-1", "batch-1"]);
  });

  it("returns null when the batch is outside the merchant scope", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await expect(readerFor(query).get({
      tenantId: "tenant-1", merchantId: "other-merchant", batchId: "batch-1"
    })).resolves.toBeNull();
  });

  it("rejects unsafe bigint values instead of rounding financial amounts", async () => {
    const query = vi.fn(async () => ({
      rows: [{ ...batchRow, gross_minor: "9007199254740992" }], rowCount: 1
    }));
    await expect(readerFor(query).get({
      tenantId: "tenant-1", merchantId: "merchant-1", batchId: "batch-1"
    })).rejects.toThrow("invalid_merchant_settlement_gross");
  });

  it("supports a draft batch that has no settlement lines yet", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        ...batchRow, status: "draft", approved_at: null, line_id: null,
        order_id: null, suborder_id: null, branch_id: null, contract_reference: null,
        gross_minor: null, deductions_minor: null, net_minor: null, deduction_breakdown: null
      }], rowCount: 1
    }));
    await expect(readerFor(query).get({
      tenantId: "tenant-1", merchantId: "merchant-1", batchId: "batch-1"
    })).resolves.toMatchObject({ status: "draft", approvedAtUtc: null, lines: [] });
  });
});
