import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PostgresPool, PostgresClient, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresMerchantSettlementPolicyProvisioner } from "./postgres-merchant-settlement-policy-provisioner.js";

function fakePool(handler: (sql: string, values: readonly unknown[]) => PostgresQueryResult<unknown> | Promise<PostgresQueryResult<unknown>>) {
  const statements: string[] = [];
  const client: PostgresClient = {
    release: vi.fn(),
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      statements.push(sql);
      return await handler(sql,values) as PostgresQueryResult<Row>;
    }
  };
  const pool = { connect: async () => client, query: client.query.bind(client) } as unknown as PostgresPool;
  return { pool, statements, valuesSeen, client };
}
const base = {
  merchantId: "merchant-1", currency: "SAR", contractReference: "contract-1",
  policyVersion: "v1", policyPayload: { deductions: { platform_fee: 1000 }, name: "base" },
  mappings: [{ deductionCode: "platform_fee", accountCode: "PLATFORM_FEE_REVENUE" }],
  approvedBy: "finance-1", approvedByRole: "finance" as const
};

describe("PostgresMerchantSettlementPolicyProvisioner", () => {
  it("creates an immutable policy snapshot, mappings, and audit event atomically", async () => {
    const fake = fakePool(sql => {
      if (sql.includes("FROM merchants")) return { rows: [{ tenant_id: "tenant-1" }], rowCount: 1 };
      if (sql.includes("FROM merchant_settlement_policy_snapshots")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM financial_accounts")) return { rows: [{ id: "fee-account", account_code: "PLATFORM_FEE_REVENUE", is_active: true }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    let id = 0;
    const provisioner = new PostgresMerchantSettlementPolicyProvisioner(fake.pool, () => `policy-id-${++id}`);
    const result = await provisioner.create(base);
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("expected_created");
    expect(result.policySnapshotId).toBe("policy-id-1");
    expect(result.policySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fake.statements[0]).toBe("BEGIN");
    expect(fake.statements.filter(sql => sql.includes("INSERT INTO merchant_settlement_deduction_account_mappings"))).toHaveLength(1);
    expect(fake.statements.some(sql => sql.includes("INSERT INTO audit_events"))).toBe(true);
    expect(fake.statements.at(-1)).toBe("COMMIT");
    expect(fake.client.release).toHaveBeenCalledOnce();
  });

  it("returns a duplicate only when the policy hash and exact account mappings match", async () => {
    const fake = fakePool(sql => {
      if (sql.includes("FROM merchants")) return { rows: [{ tenant_id: "tenant-1" }], rowCount: 1 };
      if (sql.includes("FROM merchant_settlement_policy_snapshots")) return { rows: [{
        id: "existing-policy", policy_sha256: createHash("sha256").update('{"deductions":{"platform_fee":1000},"name":"base"}').digest("hex")
      }], rowCount: 1 };
      if (sql.includes("FROM merchant_settlement_deduction_account_mappings")) return { rows: [{
        deduction_code: "platform_fee", account_code: "PLATFORM_FEE_REVENUE"
      }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const provisioner = new PostgresMerchantSettlementPolicyProvisioner(fake.pool);
    const result = await provisioner.create(base);
    expect(result.outcome).toBe("duplicate");
    expect(fake.statements.at(-1)).toBe("COMMIT");
    expect(fake.statements.some(sql => sql.includes("INSERT INTO merchant_settlement_policy_snapshots"))).toBe(false);
  });

  it("fails closed when a referenced deduction account is absent or inactive", async () => {
    const fake = fakePool(sql => {
      if (sql.includes("FROM merchants")) return { rows: [{ tenant_id: "tenant-1" }], rowCount: 1 };
      if (sql.includes("FROM merchant_settlement_policy_snapshots")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM financial_accounts")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const provisioner = new PostgresMerchantSettlementPolicyProvisioner(fake.pool);
    await expect(provisioner.create(base)).resolves.toEqual({ outcome: "accounts_missing" });
    expect(fake.statements).toContain("ROLLBACK");
    expect(fake.statements.some(sql => sql.includes("INSERT INTO merchant_settlement_policy_snapshots"))).toBe(false);
  });

  it("rejects duplicate deduction codes before opening a transaction", async () => {
    const fake = fakePool(() => ({ rows: [], rowCount: 0 }));
    const provisioner = new PostgresMerchantSettlementPolicyProvisioner(fake.pool);
    await expect(provisioner.create({
      ...base, mappings: [...base.mappings, ...base.mappings]
    })).rejects.toThrow("INVALID_MERCHANT_SETTLEMENT_POLICY_MAPPING");
    expect(fake.statements).toHaveLength(0);
  });
});
