import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

type SettlementLineRow = {
  gross_minor: string | number;
  deductions_minor: string | number;
  net_minor: string | number;
  deduction_breakdown: unknown;
};
type AccountRow = { id: string; account_code: string; account_type: string };
type JournalRow = {
  id: string; tenant_id: string; idempotency_key: string; source_type: string;
  source_reference: string; currency: string; status: "draft" | "posted";
};
export type MerchantSettlementPostingOutcome =
  | { outcome: "posted"; batchId: string; journalId: string }
  | { outcome: "duplicate"; batchId: string; journalId: string }
  | { outcome: "not_found" | "not_authorized" | "policy_missing" | "mapping_missing" | "identity_collision" };

function amount(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`SETTLEMENT_${field}_OUT_OF_RANGE`);
  return parsed;
}
function add(total: number, value: number, field: string): number {
  const next = total + value;
  if (!Number.isSafeInteger(next)) throw new Error(`SETTLEMENT_${field}_OUT_OF_RANGE`);
  return next;
}

/**
 * Atomically converts an authorized settlement batch into a posted double-entry
 * journal, marks the batch approved, and appends its audit event. It never pays out funds.
 */
export class PostgresMerchantSettlementAccountingService {
  constructor(
    private readonly pool: PostgresPool,
    private readonly createId: () => string = randomUUID
  ) {}

  /** Resolve tenant ownership from the immutable batch row for platform-only API callers. */
  async postForPlatform(batchId: string): Promise<MerchantSettlementPostingOutcome> {
    if (!batchId.trim()) throw new Error("SETTLEMENT_IDENTITY_INVALID");
    const result = await this.pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM merchant_settlement_batches WHERE id=$1",
      [batchId]
    );
    const tenantId = result.rows[0]?.tenant_id;
    if (!tenantId) return { outcome: "not_found" };
    return this.post({ tenantId, batchId });
  }

  async post(input: { tenantId: string; batchId: string }): Promise<MerchantSettlementPostingOutcome> {
    if (!input.tenantId.trim() || !input.batchId.trim()) throw new Error("SETTLEMENT_IDENTITY_INVALID");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const batchResult = await client.query<{
        id: string; tenant_id: string; merchant_id: string; currency: string;
        status: "draft" | "approved"; journal_id: string | null; policy_snapshot_id: string | null;
      }>(
        `SELECT id,tenant_id,merchant_id,currency,status,journal_id,policy_snapshot_id
         FROM merchant_settlement_batches
         WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [input.tenantId,input.batchId]
      );
      const batch = batchResult.rows[0];
      if (!batch) { await client.query("ROLLBACK"); return { outcome: "not_found" }; }
      if (batch.status === "approved" && batch.journal_id) {
        await client.query("COMMIT");
        return { outcome: "duplicate", batchId: batch.id, journalId: batch.journal_id };
      }
      if (batch.status !== "draft") throw new Error("SETTLEMENT_BATCH_STATE_INVALID");
      if (!batch.policy_snapshot_id) {
        await client.query("ROLLBACK");
        return { outcome: "policy_missing" };
      }

      const approvalResult = await client.query<{ id: string; status: string; reviewed_by: string | null; reviewer_role: string | null }>(
        `SELECT id,status,reviewed_by,reviewer_role
         FROM merchant_settlement_approval_requests
         WHERE tenant_id=$1 AND batch_id=$2
           AND status='authorized_for_accounting'
         FOR UPDATE`,
        [input.tenantId,batch.id]
      );
      if (approvalResult.rows.length !== 1 || !approvalResult.rows[0]?.reviewed_by ||
          !approvalResult.rows[0]?.reviewer_role) {
        await client.query("ROLLBACK");
        return { outcome: "not_authorized" };
      }
      const approval = approvalResult.rows[0];

      const linesResult = await client.query<SettlementLineRow>(
        `SELECT gross_minor,deductions_minor,net_minor,deduction_breakdown
         FROM merchant_settlement_lines
         WHERE tenant_id=$1 AND batch_id=$2
         ORDER BY id FOR UPDATE`,
        [input.tenantId,batch.id]
      );
      if (linesResult.rows.length === 0) throw new Error("SETTLEMENT_BATCH_EMPTY");
      let gross = 0, deductions = 0, net = 0;
      const deductionsByCode = new Map<string,number>();
      for (const row of linesResult.rows) {
        const lineGross = amount(row.gross_minor,"GROSS");
        const lineDeductions = amount(row.deductions_minor,"DEDUCTIONS");
        const lineNet = amount(row.net_minor,"NET");
        if (lineGross !== lineDeductions + lineNet) throw new Error("SETTLEMENT_LINE_NOT_BALANCED");
        gross = add(gross,lineGross,"GROSS");
        deductions = add(deductions,lineDeductions,"DEDUCTIONS");
        net = add(net,lineNet,"NET");
        if (!Array.isArray(row.deduction_breakdown)) throw new Error("SETTLEMENT_DEDUCTION_BREAKDOWN_INVALID");
        let breakdownTotal = 0;
        for (const item of row.deduction_breakdown) {
          if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("SETTLEMENT_DEDUCTION_ITEM_INVALID");
          const record = item as Record<string,unknown>;
          const code = record.code;
          const value = record.amountMinor;
          if (typeof code !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(code) ||
              typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
            throw new Error("SETTLEMENT_DEDUCTION_ITEM_INVALID");
          }
          breakdownTotal = add(breakdownTotal,value,"BREAKDOWN");
          deductionsByCode.set(code,add(deductionsByCode.get(code) ?? 0,value,"DEDUCTION_CODE"));
        }
        if (breakdownTotal !== lineDeductions) throw new Error("SETTLEMENT_DEDUCTION_BREAKDOWN_MISMATCH");
      }
      if (gross !== deductions + net || gross <= 0) throw new Error("SETTLEMENT_TOTALS_NOT_BALANCED");

      const policy = await client.query<{ contract_reference: string }>(
        `SELECT contract_reference FROM merchant_settlement_policy_snapshots
         WHERE tenant_id=$1 AND id=$2 AND merchant_id=$3 AND currency=$4`,
        [input.tenantId,batch.policy_snapshot_id,batch.merchant_id,batch.currency]
      );
      if (policy.rows.length !== 1) {
        await client.query("ROLLBACK");
        return { outcome: "policy_missing" };
      }
      const lineContracts = await client.query<{ contract_reference: string }>(
        `SELECT DISTINCT contract_reference FROM merchant_settlement_lines
         WHERE tenant_id=$1 AND batch_id=$2`,
        [input.tenantId,batch.id]
      );
      if (lineContracts.rows.length !== 1 ||
          lineContracts.rows[0]?.contract_reference !== policy.rows[0]?.contract_reference) {
        throw new Error("SETTLEMENT_CONTRACT_POLICY_MISMATCH");
      }

      const codes = [...deductionsByCode.keys()];
      const mappings = codes.length === 0 ? { rows: [] as Array<{ deduction_code: string; account_id: string }> } :
        await client.query<{ deduction_code: string; account_id: string }>(
          `SELECT deduction_code,account_id
           FROM merchant_settlement_deduction_account_mappings
           WHERE tenant_id=$1 AND policy_snapshot_id=$2 AND deduction_code=ANY($3::text[])
           ORDER BY deduction_code`,
          [input.tenantId,batch.policy_snapshot_id,codes]
        );
      const mappingByCode = new Map(mappings.rows.map(row => [row.deduction_code,row.account_id]));
      if (mappingByCode.size !== codes.length) {
        await client.query("ROLLBACK");
        return { outcome: "mapping_missing" };
      }

      const baseAccounts = await client.query<AccountRow>(
        `SELECT id,account_code,account_type FROM financial_accounts
         WHERE tenant_id=$1 AND currency=$2 AND is_active=true
           AND account_code IN ('CUSTOMER_FUNDS_HELD','MERCHANT_PAYABLE')`,
        [input.tenantId,batch.currency]
      );
      const held = baseAccounts.rows.find(row => row.account_code === "CUSTOMER_FUNDS_HELD" && row.account_type === "liability");
      const payable = baseAccounts.rows.find(row => row.account_code === "MERCHANT_PAYABLE" && row.account_type === "liability");
      if (!held || !payable || held.id === payable.id) throw new Error("SETTLEMENT_CONTROL_ACCOUNTS_MISSING");

      const mappedAccountIds = [...new Set(mappingByCode.values())];
      const mappedAccounts = mappedAccountIds.length === 0 ? { rows: [] as AccountRow[] } :
        await client.query<AccountRow>(
          `SELECT id,account_code,account_type FROM financial_accounts
           WHERE tenant_id=$1 AND currency=$2 AND is_active=true AND id=ANY($3::text[])`,
          [input.tenantId,batch.currency,mappedAccountIds]
        );
      if (mappedAccounts.rows.length !== mappedAccountIds.length ||
          mappedAccounts.rows.some(row => row.id === held.id || row.id === payable.id)) {
        throw new Error("SETTLEMENT_DEDUCTION_ACCOUNT_INVALID");
      }

      const journalId = this.createId();
      const idempotencyKey = `merchant-settlement:${batch.id}`;
      const journal = await client.query<{ id: string }>(
        `INSERT INTO financial_journals
         (id,tenant_id,idempotency_key,source_type,source_reference,currency,description,status,occurred_at)
         VALUES ($1,$2,$3,'merchant_settlement',$4,$5,$6,'draft',clock_timestamp())
         ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
         RETURNING id`,
        [journalId,input.tenantId,idempotencyKey,batch.id,batch.currency,`Merchant settlement ${batch.id}`]
      );
      if (journal.rows.length !== 1) {
        const existing = await client.query<JournalRow>(
          `SELECT id,tenant_id,idempotency_key,source_type,source_reference,currency,status
           FROM financial_journals WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [input.tenantId,idempotencyKey]
        );
        const row = existing.rows[0];
        if (row?.status === "posted" && row.source_type === "merchant_settlement" &&
            row.source_reference === batch.id && row.currency === batch.currency) {
          const updated = await client.query(
            `UPDATE merchant_settlement_batches SET status='approved',journal_id=$3
             WHERE tenant_id=$1 AND id=$2 AND status='draft' RETURNING id`,
            [input.tenantId,batch.id,row.id]
          );
          if (updated.rows.length !== 1) throw new Error("SETTLEMENT_BATCH_FINALIZE_FAILED");
          await client.query("COMMIT");
          return { outcome: "duplicate", batchId: batch.id, journalId: row.id };
        }
        await client.query("ROLLBACK");
        return { outcome: "identity_collision" };
      }

      const journalLines: Array<{ accountId: string; debit: number; credit: number; memo: string }> = [
        { accountId: held.id, debit: gross, credit: 0, memo: "Release held customer funds for merchant settlement" },
        { accountId: payable.id, debit: 0, credit: net, memo: "Merchant net payable" }
      ];
      const amountByAccount = new Map<string,number>();
      for (const [code,value] of deductionsByCode) {
        const accountId = mappingByCode.get(code)!;
        amountByAccount.set(accountId,add(amountByAccount.get(accountId) ?? 0,value,"ACCOUNT_DEDUCTION"));
      }
      for (const [accountId,value] of [...amountByAccount].sort(([a],[b]) => a.localeCompare(b))) {
        if (value > 0) journalLines.push({ accountId,debit:0,credit:value,memo:"Settlement deduction" });
      }
      if (journalLines.length < 2 || journalLines.reduce((sum,line)=>add(sum,line.debit,"DEBIT"),0) !==
          journalLines.reduce((sum,line)=>add(sum,line.credit,"CREDIT"),0)) {
        throw new Error("SETTLEMENT_JOURNAL_NOT_BALANCED");
      }
      for (let index=0; index<journalLines.length; index++) {
        const line = journalLines[index]!;
        await client.query(
          `INSERT INTO financial_journal_lines
           (id,tenant_id,journal_id,account_id,currency,line_number,debit_minor,credit_minor,memo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [this.createId(),input.tenantId,journalId,line.accountId,batch.currency,index+1,line.debit,line.credit,line.memo]
        );
      }
      const posted = await client.query(
        "UPDATE financial_journals SET status='posted' WHERE tenant_id=$1 AND id=$2 AND status='draft' RETURNING id",
        [input.tenantId,journalId]
      );
      if (posted.rows.length !== 1) throw new Error("SETTLEMENT_JOURNAL_POST_FAILED");
      const approved = await client.query(
        `UPDATE merchant_settlement_batches SET status='approved',journal_id=$3
         WHERE tenant_id=$1 AND id=$2 AND status='draft' RETURNING id`,
        [input.tenantId,batch.id,journalId]
      );
      if (approved.rows.length !== 1) throw new Error("SETTLEMENT_BATCH_FINALIZE_FAILED");

      await client.query(
        `INSERT INTO audit_events
         (id,schema_version,event_type,category,occurred_at,actor_id,actor_type,actor_role,
          action,outcome,resource_type,resource_id,tenant_id,merchant_id,correlation_id,
          source,severity,approval_id,metadata)
         VALUES ($1,1,'merchant_settlement_accounting_posted','finance',clock_timestamp(),
          $2,'platform_user',$3,'post_settlement_journal','success','merchant_settlement_batch',
          $4,$5,$6,$7,'merchant_settlement_accounting','high',$8,$9::jsonb)`,
        [`merchant-settlement-accounting:${batch.id}`,approval.reviewed_by,approval.reviewer_role,
          batch.id,input.tenantId,batch.merchant_id,approval.id,
          JSON.stringify({ journalId,policySnapshotId:batch.policy_snapshot_id,currency:batch.currency,
            grossMinor:gross,deductionsMinor:deductions,netMinor:net,lineCount:linesResult.rows.length })]
      );
      await client.query("COMMIT");
      return { outcome: "posted", batchId: batch.id, journalId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
