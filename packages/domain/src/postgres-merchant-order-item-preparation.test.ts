import { describe, expect, it, vi } from "vitest";
import { PostgresMerchantOrderItemPreparationStore } from "./postgres-merchant-order-item-preparation.js";
import type { PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";

function fakePool(options: { item?: boolean; existing?: boolean } = {}) {
  const statements: string[] = [];
  const query = vi.fn(async <Row>(sql: string, _values?: readonly unknown[]) => {
    statements.push(sql);
    let rows: unknown[] = [];
    let rowCount: number | null = 1;
    if (sql.includes("SELECT i.sku")) {
      rows = options.item === false ? [] : [{
        sku: "SKU-DB", quantity: 2, size_label: "M", color_label: "Black"
      }];
      rowCount = rows.length;
    } else if (sql.includes("SELECT id, actor_id, scanned_sku")) {
      rows = options.existing ? [{
        id: "check-1", actor_id: "employee-1", scanned_sku: "SKU-DB",
        verified_quantity: 2, outcome: "verified", note: null
      }] : [];
      rowCount = rows.length;
    }
    return { rows: rows as Row[], rowCount } as PostgresQueryResult<Row>;
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as PostgresPool;
  return { pool, query, statements, client };
}

const input = {
  id: "check-1", tenantId: "tenant-1", orderId: "order-1",
  suborderId: "sub-1", orderItemId: "item-1", merchantId: "merchant-1",
  branchId: "branch-1", actorId: "employee-1", scannedSku: "SKU-DB",
  verifiedQuantity: 2, outcome: "verified" as const
};

describe("PostgresMerchantOrderItemPreparationStore", () => {
  it("records a verified check using SKU and quantity from the locked database item", async () => {
    const db = fakePool();
    const result = await new PostgresMerchantOrderItemPreparationStore(db.pool).record(input);
    expect(result).toEqual({ outcome: "recorded", expectedSku: "SKU-DB", expectedQuantity: 2 });
    const insert = db.query.mock.calls.find(([sql]) => sql.startsWith("INSERT INTO merchant_order_item_preparation_checks"));
    expect(insert?.[1]).toContain("SKU-DB");
    expect(insert?.[1]).toContain(2);
    expect(db.statements.at(-1)).toBe("COMMIT");
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it("rejects a client SKU or quantity that does not match the persisted item", async () => {
    const db = fakePool();
    const result = await new PostgresMerchantOrderItemPreparationStore(db.pool).record({
      ...input, scannedSku: "FORGED-SKU"
    });
    expect(result).toEqual({ outcome: "invalid_check", reason: "check_does_not_match_persisted_item" });
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements.some(sql => sql.startsWith("INSERT"))).toBe(false);
  });

  it("does not disclose or record an item outside the requested branch scope", async () => {
    const db = fakePool({ item: false });
    const result = await new PostgresMerchantOrderItemPreparationStore(db.pool).record(input);
    expect(result).toEqual({ outcome: "not_found" });
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements.some(sql => sql.startsWith("INSERT"))).toBe(false);
  });

  it("treats the same persisted check as idempotent and rejects a different check", async () => {
    const db = fakePool({ existing: true });
    const store = new PostgresMerchantOrderItemPreparationStore(db.pool);
    expect(await store.record(input)).toMatchObject({ outcome: "already_recorded" });
    expect(await store.record({ ...input, verifiedQuantity: 1, outcome: "shortage" })).toEqual({ outcome: "conflict" });
    expect(db.statements.some(sql => sql.startsWith("INSERT"))).toBe(false);
  });

  it("persists a shortage as a non-verified outcome", async () => {
    const db = fakePool();
    const result = await new PostgresMerchantOrderItemPreparationStore(db.pool).record({
      ...input, outcome: "shortage", verifiedQuantity: 1
    });
    expect(result).toMatchObject({ outcome: "recorded" });
  });
});
