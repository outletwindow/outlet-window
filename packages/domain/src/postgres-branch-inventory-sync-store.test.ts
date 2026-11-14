import { describe, expect, it } from "vitest";
import type { PostgresClient, PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresBranchInventorySyncStore } from "./branch-inventory-sync.js";

class SnapshotClient implements PostgresClient {
  statements: { sql: string; values: readonly unknown[] }[] = [];
  released = false;
  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    this.statements.push({ sql: sql.trim().replace(/\s+/g, " "), values });
    if (sql.includes("FROM merchant_branches b")) {
      return { rows: [{ id: "branch-1", inventory_snapshot_at: null } as Row], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO branch_inventory")) {
      return { rows: [{ product_variant_id: "variant-present" } as Row], rowCount: 1 };
    }
    if (sql.includes("UPDATE branch_inventory")) {
      return { rows: [{ product_variant_id: "variant-omitted" } as Row], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }
  release(): void { this.released = true; }
}

class SnapshotPool implements PostgresPool {
  client = new SnapshotClient();
  async query<Row>(): Promise<PostgresQueryResult<Row>> { return { rows: [], rowCount: 0 }; }
  async connect(): Promise<PostgresClient> { return this.client; }
}

describe("PostgreSQL complete branch inventory snapshots", () => {
  it("zeros omitted variants while preserving reservations and newer snapshot ordering", async () => {
    const pool = new SnapshotPool();
    const store = new PostgresBranchInventorySyncStore(pool);
    const result = await store.applySnapshot({
      tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1",
      source: "pos", capturedAtUtc: "2026-11-14T12:00:00.000Z", confidence: "high",
      lines: [{ productVariantId: "variant-present", sku: "SKU-1", availableQuantity: 8 }]
    });

    expect(result).toEqual({ accepted: 2, stale: 0 });
    const omitted = pool.client.statements.find(item => item.sql.includes("UPDATE branch_inventory"));
    expect(omitted?.sql).toContain("SET available_quantity = reserved_quantity");
    expect(omitted?.sql).toContain("NOT (product_variant_id = ANY($3::text[]))");
    expect(omitted?.sql).toContain("last_synced_at <= $5");
    expect(omitted?.values).toEqual([
      "merchant-1", "branch-1", ["variant-present"], "pos",
      "2026-11-14T12:00:00.000Z", "high"
    ]);
    expect(pool.client.statements.at(-1)?.sql).toBe("COMMIT");
    expect(pool.client.released).toBe(true);
  });

  it("clamps sellable stock and records a reconciliation alert when source stock is below reservations", async () => {
    class ConflictClient extends SnapshotClient {
      override async query<Row>(sql: string, values: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
        const normalized = sql.trim().replace(/\\s+/g, " ");
        this.statements.push({ sql: normalized, values });
        if (sql.includes("FROM merchant_branches b")) {
          return { rows: [{ id: "branch-1", inventory_snapshot_at: null } as Row], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO branch_inventory")) return { rows: [], rowCount: 0 };
        if (sql.includes("SELECT last_synced_at, reserved_quantity FROM branch_inventory")) {
          return { rows: [{
            last_synced_at: "2026-11-14T12:00:00.000Z", reserved_quantity: 5
          } as Row], rowCount: 1 };
        }
        if (sql.includes("SET available_quantity = reserved_quantity") &&
            sql.includes("product_variant_id = $3")) {
          return { rows: [{ reserved_quantity: 5 } as Row], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO branch_inventory_reconciliation_alerts")) {
          return { rows: [{ id: "alert-1" } as Row], rowCount: 1 };
        }
        if (sql.includes("UPDATE branch_inventory")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      }
    }
    const client = new ConflictClient();
    const pool: PostgresPool = {
      async query<Row>(): Promise<PostgresQueryResult<Row>> { return { rows: [], rowCount: 0 }; },
      async connect(): Promise<PostgresClient> { return client; }
    };
    const store = new PostgresBranchInventorySyncStore(pool);
    const result = await store.applySnapshot({
      tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1",
      source: "pos", capturedAtUtc: "2026-11-14T12:00:00.000Z", confidence: "high",
      lines: [{ productVariantId: "variant-1", sku: "SKU-1", availableQuantity: 2 }]
    });

    expect(result).toEqual({ accepted: 1, stale: 0 });
    const clamp = client.statements.find(item =>
      item.sql.includes("SET available_quantity = reserved_quantity") &&
      item.sql.includes("product_variant_id = $3")
    );
    expect(clamp?.sql).toContain("availability_confidence = 'low'");
    const alert = client.statements.find(item =>
      item.sql.includes("INSERT INTO branch_inventory_reconciliation_alerts")
    );
    expect(alert?.values).toEqual([
      expect.any(String), "tenant-1", "merchant-1", "branch-1", "variant-1",
      "pos", "2026-11-14T12:00:00.000Z", 2, 5
    ]);
    expect(client.statements.at(-1)?.sql).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it("rejects an older complete snapshot before updating any variant or clearing omissions", async () => {
    class NewerSnapshotClient extends SnapshotClient {
      override async query<Row>(sql: string, values: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
        this.statements.push({ sql: sql.trim(), values });
        if (sql.includes("FROM merchant_branches b")) {
          return { rows: [{ id: "branch-1", inventory_snapshot_at: "2026-11-14T12:05:00.000Z" } as Row], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    }
    const client = new NewerSnapshotClient();
    const pool: PostgresPool = {
      async query<Row>(): Promise<PostgresQueryResult<Row>> { return { rows: [], rowCount: 0 }; },
      async connect(): Promise<PostgresClient> { return client; }
    };
    const store = new PostgresBranchInventorySyncStore(pool);
    const result = await store.applySnapshot({
      tenantId: "tenant-1", merchantId: "merchant-1", branchId: "branch-1",
      source: "pos", capturedAtUtc: "2026-11-14T12:00:00.000Z", confidence: "low",
      lines: [{ productVariantId: "variant-old", sku: "SKU-OLD", availableQuantity: 2 }]
    });
    expect(result).toEqual({ accepted: 0, stale: 1 });
    expect(client.statements.some(item => item.sql.includes("INSERT INTO branch_inventory"))).toBe(false);
    expect(client.statements.some(item => item.sql.includes("UPDATE branch_inventory"))).toBe(false);
    expect(client.statements.some(item => item.sql.includes("UPDATE merchant_branches"))).toBe(false);
    expect(client.statements.at(-1)?.sql).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it("rolls back when the tenant does not own the branch", async () => {
    class MissingBranchClient extends SnapshotClient {
      override async query<Row>(sql: string, values: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
        this.statements.push({ sql: sql.trim().replace(/\s+/g, " "), values });
        if (sql.includes("FROM merchant_branches b")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      }
    }
    const client = new MissingBranchClient();
    const pool: PostgresPool = {
      async query<Row>(): Promise<PostgresQueryResult<Row>> { return { rows: [], rowCount: 0 }; },
      async connect(): Promise<PostgresClient> { return client; }
    };
    const store = new PostgresBranchInventorySyncStore(pool);
    await expect(store.applySnapshot({
      tenantId: "other-tenant", merchantId: "merchant-1", branchId: "branch-1",
      source: "pos", capturedAtUtc: "2026-11-14T12:00:00.000Z", confidence: "high",
      lines: [{ productVariantId: "variant-1", sku: "SKU-1", availableQuantity: 3 }]
    })).rejects.toThrow("BRANCH_INVENTORY_SCOPE_NOT_FOUND");
    expect(client.statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(client.released).toBe(true);
  });
});
