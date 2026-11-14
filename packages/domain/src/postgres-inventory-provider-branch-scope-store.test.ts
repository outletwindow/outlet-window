import { describe, expect, it, vi } from "vitest";
import type { PostgresQueryable } from "./postgres-iam-store.js";
import { PostgresInventoryProviderBranchScopeStore } from "./postgres-inventory-provider-branch-scope-store.js";

const input = {
  tenantId: "tenant-1", integrationId: "pos-1",
  merchantId: "merchant-1", branchId: "branch-1"
};

function database(rowCount: number) {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
    rows: rowCount ? [{ integration_id: "pos-1", id: "pos-1" }] : [],
    rowCount
  }));
  return { client: { query } as unknown as PostgresQueryable, query };
}

describe("PostgresInventoryProviderBranchScopeStore", () => {
  it("approves hard reservation capability only for connected POS/ERP integrations", async () => {
    const db = database(1);
    const store = new PostgresInventoryProviderBranchScopeStore(db.client);
    await expect(store.approveHardReservationCapability({ tenantId: "tenant-1", integrationId: "pos-1" })).resolves.toBe("approved");
    expect(db.query.mock.calls[0]?.[1]).toEqual(["tenant-1", "pos-1"]);
    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("family IN ('pos', 'erp')");
    expect(sql).toContain("status = 'connected'");
    expect(sql).toContain("capabilities || '[\"inventory.hard_reservation\"]'::jsonb");
  });

  it("does not approve unverified, non-POS/ERP, or missing integrations", async () => {
    const db = database(0);
    const store = new PostgresInventoryProviderBranchScopeStore(db.client);
    await expect(store.approveHardReservationCapability({ tenantId: "tenant-1", integrationId: "pos-1" })).resolves.toBe("not_eligible");
  });

  it("grants only connected POS/ERP integrations with platform-approved hard reservation capability", async () => {
    const db = database(1);
    const store = new PostgresInventoryProviderBranchScopeStore(db.client);
    await expect(store.grant(input)).resolves.toBe("granted");
    expect(db.query.mock.calls[0]?.[1]).toEqual(["tenant-1", "pos-1", "merchant-1", "branch-1"]);
    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("i.family IN ('pos', 'erp')");
    expect(sql).toContain("i.status = 'connected'");
    expect(sql).toContain("i.capabilities @> '[\"inventory.hard_reservation\"]'::jsonb");
    expect(sql).toContain("m.status = 'active'");
    expect(sql).toContain("b.status = 'active'");
    expect(sql).toContain("ON CONFLICT (tenant_id, integration_id, merchant_id, branch_id)");
  });

  it("refuses to grant a scope when provider or branch is not eligible", async () => {
    const db = database(0);
    const store = new PostgresInventoryProviderBranchScopeStore(db.client);
    await expect(store.grant(input)).resolves.toBe("not_eligible");
  });

  it("revokes only the exact active tenant/integration/merchant/branch grant", async () => {
    const db = database(1);
    const store = new PostgresInventoryProviderBranchScopeStore(db.client);
    await expect(store.revoke(input)).resolves.toBe("revoked");
    expect(db.query.mock.calls[0]?.[1]).toEqual(["tenant-1", "pos-1", "merchant-1", "branch-1"]);
    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("active = false");
    expect(sql).toContain("tenant_id = $1 AND integration_id = $2");
    expect(sql).toContain("merchant_id = $3 AND branch_id = $4 AND active = true");
  });

  it("reports missing grants without broadening the scope", async () => {
    const db = database(0);
    const store = new PostgresInventoryProviderBranchScopeStore(db.client);
    await expect(store.revoke(input)).resolves.toBe("not_found");
  });
});
