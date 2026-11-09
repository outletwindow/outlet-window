import { describe, expect, it } from "vitest";
import type { PostgresQueryable, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresBranchInventoryReader } from "./postgres-branch-inventory-reader.js";

class InventoryReadDb implements PostgresQueryable {
  sql = "";
  values: readonly unknown[] = [];
  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    this.sql = sql;
    this.values = values;
    return {
      rows: [{
        product_variant_id: "variant-1", sku: "SKU-1",
        available_quantity: 9, reserved_quantity: 3, source: "pos",
        last_synced_at: "2026-11-09T10:00:00.000Z", availability_confidence: "high"
      }] as Row[],
      rowCount: 1
    };
  }
}

describe("PostgreSQL branch inventory reader", () => {
  it("enforces tenant, merchant, and branch predicates and returns stock freshness", async () => {
    const db = new InventoryReadDb();
    const reader = new PostgresBranchInventoryReader(db);
    const result = await reader.list({
      tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1", limit: 30
    });
    expect(db.sql).toContain("m.tenant_id = $1 AND m.id = $2 AND b.id = $3");
    expect(db.sql).toContain("m.status = 'active' AND b.status = 'active'");
    expect(db.values).toEqual(["tenant-1", "merchant-1", "branch-1", 30]);
    expect(result).toEqual([{
      productVariantId: "variant-1", sku: "SKU-1",
      availableQuantity: 9, reservedQuantity: 3,
      source: "pos", lastSyncedAtUtc: "2026-11-09T10:00:00.000Z", confidence: "high"
    }]);
  });

  it("rejects invalid tenant/branch identifiers and unbounded limits before querying", async () => {
    let calls = 0;
    const db: PostgresQueryable = {
      async query<Row>() { calls += 1; return { rows: [], rowCount: 0 }; }
    };
    const reader = new PostgresBranchInventoryReader(db);
    await expect(reader.list({ tenantId: "", merchantId: "merchant-1", branchId: "branch-1" }))
      .rejects.toThrow("invalid_branch_inventory_read");
    await expect(reader.list({ tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1", limit: 1000 }))
      .rejects.toThrow("invalid_branch_inventory_read");
    expect(calls).toBe(0);
  });
});
