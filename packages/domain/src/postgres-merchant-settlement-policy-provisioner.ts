import { createHash, randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

export interface MerchantSettlementPolicyMappingInput {
  deductionCode: string;
  accountCode: string;
}
export interface CreateMerchantSettlementPolicyInput {
  merchantId: string;
  currency: string;
  contractReference: string;
  policyVersion: string;
  policyPayload: Readonly<Record<string, unknown>>;
  mappings: readonly MerchantSettlementPolicyMappingInput[];
  approvedBy: string;
  approvedByRole: "finance" | "platform_admin" | "platform_owner";
}
export type MerchantSettlementPolicyProvisionResult =
  | { outcome: "created" | "duplicate"; policySnapshotId: string; policySha256: string }
  | { outcome: "merchant_not_found" | "accounts_missing" | "identity_collision" };

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
function validate(input: CreateMerchantSettlementPolicyInput): void {
  if (!input.merchantId.trim() || input.merchantId.length > 200 ||
      !/^[A-Z]{3}$/.test(input.currency) ||
      !input.contractReference.trim() || input.contractReference.length > 240 ||
      !/^[A-Za-z0-9._:-]{1,120}$/.test(input.policyVersion) ||
      !input.approvedBy.trim() || input.approvedBy.length > 160 ||
      !["finance","platform_admin","platform_owner"].includes(input.approvedByRole) ||
      !input.policyPayload || typeof input.policyPayload !== "object" || Array.isArray(input.policyPayload) ||
      !Array.isArray(input.mappings) || input.mappings.length > 100) {
    throw new Error("INVALID_MERCHANT_SETTLEMENT_POLICY");
  }
  const codes = new Set<string>();
  for (const mapping of input.mappings) {
    if (!mapping || typeof mapping !== "object" ||
        typeof mapping.deductionCode !== "string" || typeof mapping.accountCode !== "string" ||
        !/^[a-z][a-z0-9_]{0,79}$/.test(mapping.deductionCode) ||
        !/^[A-Z0-9_]{1,80}$/.test(mapping.accountCode) || codes.has(mapping.deductionCode)) {
      throw new Error("INVALID_MERCHANT_SETTLEMENT_POLICY_MAPPING");
    }
    codes.add(mapping.deductionCode);
  }
  const encoded = stableJson(input.policyPayload);
  if (Buffer.byteLength(encoded, "utf8") > 100_000) throw new Error("MERCHANT_SETTLEMENT_POLICY_TOO_LARGE");
}

type PolicyRow = { id: string; policy_sha256: string };
type MappingRow = { deduction_code: string; account_code: string };

export class PostgresMerchantSettlementPolicyProvisioner {
  constructor(
    private readonly pool: PostgresPool,
    private readonly createId: () => string = randomUUID
  ) {}

  async bindToBatch(input: {
    batchId: string;
    policySnapshotId: string;
  }): Promise<
    | { outcome: "bound" | "duplicate"; batchId: string; policySnapshotId: string }
    | { outcome: "batch_not_found" | "policy_not_found" | "batch_not_draft" | "contract_mismatch" | "binding_conflict" }
  > {
    if (!input.batchId.trim() || input.batchId.length > 200 ||
        !input.policySnapshotId.trim() || input.policySnapshotId.length > 200) {
      throw new Error("INVALID_SETTLEMENT_POLICY_BINDING");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const batchResult = await client.query<{
        id: string; tenant_id: string; merchant_id: string; currency: string;
        status: string; policy_snapshot_id: string | null;
      }>(
        `SELECT id,tenant_id,merchant_id,currency,status,policy_snapshot_id
         FROM merchant_settlement_batches WHERE id=$1 FOR UPDATE`,
        [input.batchId]
      );
      const batch = batchResult.rows[0];
      if (!batch) { await client.query("ROLLBACK"); return { outcome: "batch_not_found" }; }
      if (batch.status !== "draft") { await client.query("ROLLBACK"); return { outcome: "batch_not_draft" }; }
      if (batch.policy_snapshot_id) {
        await client.query("COMMIT");
        return batch.policy_snapshot_id === input.policySnapshotId
          ? { outcome: "duplicate", batchId: batch.id, policySnapshotId: input.policySnapshotId }
          : { outcome: "binding_conflict" };
      }
      const policyResult = await client.query<{ id: string; contract_reference: string }>(
        `SELECT id,contract_reference FROM merchant_settlement_policy_snapshots
         WHERE tenant_id=$1 AND id=$2 AND merchant_id=$3 AND currency=$4`,
        [batch.tenant_id,input.policySnapshotId,batch.merchant_id,batch.currency]
      );
      const policy = policyResult.rows[0];
      if (!policy) { await client.query("ROLLBACK"); return { outcome: "policy_not_found" }; }
      const contracts = await client.query<{ contract_reference: string }>(
        `SELECT DISTINCT contract_reference FROM merchant_settlement_lines
         WHERE tenant_id=$1 AND batch_id=$2`,
        [batch.tenant_id,batch.id]
      );
      if (contracts.rows.some(row => row.contract_reference !== policy.contract_reference) ||
          contracts.rows.length > 1) {
        await client.query("ROLLBACK");
        return { outcome: "contract_mismatch" };
      }
      const updated = await client.query(
        `UPDATE merchant_settlement_batches SET policy_snapshot_id=$3
         WHERE tenant_id=$1 AND id=$2 AND status='draft' AND policy_snapshot_id IS NULL
         RETURNING id`,
        [batch.tenant_id,batch.id,input.policySnapshotId]
      );
      if (updated.rows.length !== 1) {
        await client.query("ROLLBACK");
        return { outcome: "binding_conflict" };
      }
      await client.query(
        `INSERT INTO audit_events
         (id,schema_version,event_type,category,occurred_at,actor_id,actor_type,actor_role,
          action,outcome,resource_type,resource_id,tenant_id,merchant_id,correlation_id,
          source,severity,metadata)
         VALUES ($1,1,'merchant_settlement_policy_bound_to_batch','finance',clock_timestamp(),
          'system:settlement-policy-binding','system','system','bind_settlement_policy','success',
          'merchant_settlement_batch',$2,$3,$4,$5,'merchant_settlement_policy','high',$6::jsonb)`,
        [`settlement-policy-binding:${batch.id}`,batch.id,batch.tenant_id,batch.merchant_id,
          batch.id,JSON.stringify({ policySnapshotId:input.policySnapshotId,contractReference:policy.contract_reference })]
      );
      await client.query("COMMIT");
      return { outcome: "bound", batchId: batch.id, policySnapshotId: input.policySnapshotId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async create(input: CreateMerchantSettlementPolicyInput): Promise<MerchantSettlementPolicyProvisionResult> {
    validate(input);
    const payload = stableJson(input.policyPayload);
    const policySha256 = createHash("sha256").update(payload, "utf8").digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const merchant = await client.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM merchants WHERE id=$1 AND status='active' FOR UPDATE",
        [input.merchantId]
      );
      const tenantId = merchant.rows[0]?.tenant_id;
      if (!tenantId) {
        await client.query("ROLLBACK");
        return { outcome: "merchant_not_found" };
      }

      const existing = await client.query<PolicyRow>(
        `SELECT id,policy_sha256 FROM merchant_settlement_policy_snapshots
         WHERE tenant_id=$1 AND merchant_id=$2 AND currency=$3
           AND contract_reference=$4 AND policy_version=$5 FOR UPDATE`,
        [tenantId,input.merchantId,input.currency,input.contractReference,input.policyVersion]
      );
      if (existing.rows.length) {
        const row = existing.rows[0]!;
        const existingMappings = await client.query<MappingRow>(
          `SELECT m.deduction_code,a.account_code
           FROM merchant_settlement_deduction_account_mappings m
           JOIN financial_accounts a
             ON a.tenant_id=m.tenant_id AND a.id=m.account_id AND a.currency=m.currency
           WHERE m.tenant_id=$1 AND m.policy_snapshot_id=$2
           ORDER BY m.deduction_code`,
          [tenantId,row.id]
        );
        const expected = [...input.mappings].map(m => ({ deduction_code:m.deductionCode,account_code:m.accountCode }))
          .sort((a,b)=>a.deduction_code.localeCompare(b.deduction_code));
        const sameMappings = JSON.stringify(existingMappings.rows) === JSON.stringify(expected);
        await client.query("COMMIT");
        return row.policy_sha256 === policySha256 && sameMappings
          ? { outcome: "duplicate", policySnapshotId: row.id, policySha256 }
          : { outcome: "identity_collision" };
      }

      const accountCodes = [...new Set(input.mappings.map(mapping => mapping.accountCode))];
      const accounts = accountCodes.length === 0 ? { rows: [] as Array<{ id: string; account_code: string; is_active: boolean }> } :
        await client.query<{ id: string; account_code: string; is_active: boolean }>(
          `SELECT id,account_code,is_active FROM financial_accounts
           WHERE tenant_id=$1 AND currency=$2 AND account_code=ANY($3::text[])
           ORDER BY account_code FOR UPDATE`,
          [tenantId,input.currency,accountCodes]
        );
      const accountByCode = new Map(accounts.rows.map(account => [account.account_code,account]));
      if (accountByCode.size !== accountCodes.length ||
          accounts.rows.some(account => !account.is_active)) {
        await client.query("ROLLBACK");
        return { outcome: "accounts_missing" };
      }

      const policySnapshotId = this.createId();
      await client.query(
        `INSERT INTO merchant_settlement_policy_snapshots
         (id,tenant_id,merchant_id,currency,contract_reference,policy_version,policy_sha256,
          policy_payload,approved_by,approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,clock_timestamp())`,
        [policySnapshotId,tenantId,input.merchantId,input.currency,input.contractReference,
          input.policyVersion,policySha256,payload,input.approvedBy]
      );
      for (const mapping of [...input.mappings].sort((a,b)=>a.deductionCode.localeCompare(b.deductionCode))) {
        const account = accountByCode.get(mapping.accountCode);
        if (!account) throw new Error("SETTLEMENT_POLICY_ACCOUNT_LOOKUP_FAILED");
        await client.query(
          `INSERT INTO merchant_settlement_deduction_account_mappings
           (id,tenant_id,policy_snapshot_id,merchant_id,currency,contract_reference,deduction_code,account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [this.createId(),tenantId,policySnapshotId,input.merchantId,input.currency,
            input.contractReference,mapping.deductionCode,account.id]
        );
      }
      await client.query(
        `INSERT INTO audit_events
         (id,schema_version,event_type,category,occurred_at,actor_id,actor_type,actor_role,
          action,outcome,resource_type,resource_id,tenant_id,merchant_id,correlation_id,
          source,severity,metadata)
         VALUES ($1,1,'merchant_settlement_policy_snapshot_created','finance',clock_timestamp(),
          $2,'platform_user',$3,'create_settlement_policy_snapshot','success',
          'merchant_settlement_policy_snapshot',$3,$4,$5,$6,'merchant_settlement_policy','high',$7::jsonb)`,
        [`merchant-settlement-policy:${policySnapshotId}`,input.approvedBy,input.approvedByRole,policySnapshotId,
          tenantId,input.merchantId,policySnapshotId,
          JSON.stringify({ currency:input.currency,contractReference:input.contractReference,
            policyVersion:input.policyVersion,policySha256,mappingCount:input.mappings.length })]
      );
      await client.query("COMMIT");
      return { outcome: "created", policySnapshotId, policySha256 };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error && typeof error === "object" && "code" in error &&
          String((error as { code: unknown }).code) === "23505") {
        return { outcome: "identity_collision" };
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
