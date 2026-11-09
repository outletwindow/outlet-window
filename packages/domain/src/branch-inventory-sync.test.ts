import { describe, expect, it } from "vitest";
import {
  BranchInventorySyncService, inventoryConfidence,
  type BranchInventorySyncRequest, type BranchInventorySyncStore
} from "./branch-inventory-sync.js";

const base: BranchInventorySyncRequest = {
  tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1",
  source: "pos", capturedAtUtc: "2026-11-09T10:00:00.000Z",
  lines: [{ productVariantId: "variant-1", sku: "SKU-1", availableQuantity: 4 }]
};

describe("branch inventory snapshot sync", () => {
  it("accepts a valid branch snapshot and reports freshness confidence", async () => {
    let received: BranchInventorySyncRequest | undefined;
    const store: BranchInventorySyncStore = { async applySnapshot(input) {
      received = input; return { accepted: 1, stale: 0 };
    }};
    const service = new BranchInventorySyncService(store, () => new Date("2026-11-09T10:03:00.000Z"));
    const result = await service.sync(base);
    expect(received?.branchId).toBe("branch-1");
    expect(result).toEqual({ accepted: 1, stale: 0, confidence: "high", capturedAtUtc: base.capturedAtUtc });
  });

  it("rejects duplicate variants, negative stock, and malformed snapshots before persistence", async () => {
    let calls = 0;
    const service = new BranchInventorySyncService({ async applySnapshot() { calls++; return { accepted: 0, stale: 0 }; } });
    await expect(service.sync({ ...base, lines: [...base.lines, base.lines[0]!] })).rejects.toThrow("INVALID_BRANCH_INVENTORY_LINE");
    await expect(service.sync({ ...base, lines: [{ ...base.lines[0]!, availableQuantity: -1 }] })).rejects.toThrow("INVALID_BRANCH_INVENTORY_LINE");
    await expect(service.sync({ ...base, capturedAtUtc: "not-a-date" })).rejects.toThrow("INVALID_BRANCH_INVENTORY_SNAPSHOT");
    expect(calls).toBe(0);
  });

  it("classifies stale stock conservatively", () => {
    expect(inventoryConfidence("2026-11-09T09:00:00.000Z", "2026-11-09T10:00:00.000Z")).toBe("low");
    expect(inventoryConfidence("2026-11-09T10:00:00.000Z", "2026-11-09T10:00:00.000Z")).toBe("high");
    expect(inventoryConfidence("2026-11-09T10:01:00.000Z", "2026-11-09T10:00:00.000Z")).toBe("unknown");
  });
});
