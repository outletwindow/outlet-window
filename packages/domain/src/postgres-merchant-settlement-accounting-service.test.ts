import { describe, expect, it, vi } from "vitest";
import type { PostgresPool, PostgresClient, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresMerchantSettlementAccountingService } from "./postgres-merchant-settlement-accounting-service.js";

function poolWith(handler: (sql: string, values: readonly unknown[]) => PostgresQueryResult<unknown> | Promise<PostgresQueryResult<unknown>>) {
  const statements: string[] = [];
  const client: PostgresClient = {
    release: vi.fn(),
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      statements.push(sql);
      return await handler(sql, values) as PostgresQueryResult<Row>;
    }
  };
  const pool = { connect: async () => client, query: client.query.bind(client) } as unknown as PostgresPool;
  return { pool, statements, client };
}

const batch = {
  id: "batch-1", tenant_id: "tenant-1", merchant_id: "merchant-1", currency: "SAR",
  status: "draft", journal_id: null, policy_snapshot_id: "policy-1"
};
const line = {
  gross_minor: "12000", deductions_minor: "1000", net_minor: "11000",
  deduction_breakdown: [{ code: "platform_fee", amountMinor: 1000 }]
};

describe("PostgresMerchantSettlementAccountingService", () => {
  it("posts the mapped balanced journal, approves the batch, and audits in one transaction", async () => {
    const fake = poolWith(sql => {
      if (sql.includes("FROM merchant_settlement_batches") && sql.includes("FOR UPDATE")) return { rows: [batch], rowCount: 1 };
      if (sql.includes("FROM merchant_settlement_approval_requests")) return { rows: [{ id: "approval-1", status: "authorized_for_accounting", reviewed_by: "finance-1", reviewer_role: "finance" }], rowCount: 1 };
      if (sql.includes("FROM merchant_settlement_lines") && sql.includes("ORDER BY id")) return { rows: [line], rowCount: 1 };
      if (sql.includes("FROM merchant_settlement_policy_snapshots")) return { rows: [{ contract_reference: "contract-1" }], rowCount: 1 };
      if (sql.includes("SELECT DISTINCT contract_reference")) return { rows: [{ contract_reference: "contract-1" }], rowCount: 1 };
      if (sql.includes("FROM merchant_settlement_deduction_account_mappings")) return { rows: [{ deduction_code: "platform_fee", account_id: "fee-account" }], rowCount: 1 };
      if (sql.includes("FROM financial_accounts") && sql.includes("account_code IN")) return { rows: [
        { id: "held-account", account_code: "CUSTOMER_FUNDS_HELD", account_type: "liability" },
        { id: "payable-account", account_code: "MERCHANT_PAYABLE", account_type: "liability" }
      ], rowCount: 2 };
      if (sql.includes("FROM financial_accounts") && sql.includes("id=ANY")) return { rows: [
        { id: "fee-account", account_code: "PLATFORM_FEE", account_type: "revenue" }
      ], rowCount: 1 };
      if (sql.includes("INSERT INTO financial_journals")) return { rows: [{ id: "journal-1" }], rowCount: 1 };
      if (sql.includes("UPDATE financial_journals")) return { rows: [{ id: "journal-1" }], rowCount: 1 };
      if (sql.includes("UPDATE merchant_settlement_batches")) return { rows: [{ id: "batch-1" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    let id = 0;
    const service = new PostgresMerchantSettlementAccountingService(fake.pool, () => `id-${++id}`);
    await expect(service.post({ tenantId: "tenant-1", batchId: "batch-1" })).resolves.toEqual({
      outcome: "posted", batchId: "batch-1", journalId: "id-1"
    });
    expect(fake.statements[0]).toBe("BEGIN");
    expect(fake.statements.filter(sql => sql.includes("INSERT INTO financial_journal_lines"))).toHaveLength(3);
    expect(fake.statements.some(sql => sql.includes("INSERT INTO audit_events"))).toBe(true);
    expect(fake.statements.at(-1)).toBe("COMMIT");
    expect(fake.client.release).toHaveBeenCalledOnce();
  });

  it("fails closed when a deduction code has no policy account mapping", async () => {
    const fake = poolWith(sql => {
      if (sql.includes("FROM merchant_settlement_batches") && sql.includes("FOR UPDATE")) return { rows: [batch], rowCount: 1 };
      if (sql.includes("FROM merchant_settlement_approval_requests")) return { rows: [{ id: "approval-1", status: "authorized_for_accounting", reviewed_by: "finance-1", reviewer_role: "finance" }], rowCount: 1 };
      if (sql.includes("FROM merchant_settlement_lines") && sql.includes("ORDER BY id")) return { rows: [line], rowCount: 1 };
      if (sql.includes("FROM merchant_settlement_policy_snapshots")) return { rows: [{ contract_reference: "contract-1" }], rowCount: 1 };
      if (sql.includes("SELECT DISTINCT contract_reference")) return { rows: [{ contract_reference: "contract-1" }], rowCount: 1 };
      if (sql.includes("FROM merchant_settlement_deduction_account_mappings")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const service = new PostgresMerchantSettlementAccountingService(fake.pool);
    await expect(service.post({ tenantId: "tenant-1", batchId: "batch-1" })).resolves.toEqual({ outcome: "mapping_missing" });
    expect(fake.statements).toContain("ROLLBACK");
    expect(fake.statements.some(sql => sql.includes("INSERT INTO financial_journals"))).toBe(false);
  });

  it("does not post a batch without an authorized two-person review", async () => {
    const fake = poolWith(sql => {
      if (sql.includes("FROM merchant_settlement_batches") && sql.includes("FOR UPDATE")) return { rows: [batch], rowCount: 1 };
      if (sql.includes("FROM merchant_settlement_approval_requests")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const service = new PostgresMerchantSettlementAccountingService(fake.pool);
    await expect(service.post({ tenantId: "tenant-1", batchId: "batch-1" })).resolves.toEqual({ outcome: "not_authorized" });
    expect(fake.statements).toContain("ROLLBACK");
  });
});
