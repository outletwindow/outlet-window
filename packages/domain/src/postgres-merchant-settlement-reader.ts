import type { PostgresPool } from "./postgres-iam-store.js";

export interface MerchantSettlementLine {
  id: string;
  orderId: string;
  suborderId: string;
  branchId: string;
  contractReference: string;
  grossMinor: number;
  deductionsMinor: number;
  netMinor: number;
  deductionBreakdown: Array<{ code: string; amountMinor: number }>;
}
export interface MerchantSettlementBatchSummary {
  id: string;
  merchantId: string;
  currency: string;
  periodStartUtc: string;
  periodEndUtc: string;
  status: "draft" | "approved";
  createdAtUtc: string;
  approvedAtUtc: string | null;
  lineCount: number;
  grossMinor: number;
  deductionsMinor: number;
  netMinor: number;
}
export interface MerchantSettlementBatch {
  id: string;
  merchantId: string;
  currency: string;
  periodStartUtc: string;
  periodEndUtc: string;
  status: "draft" | "approved";
  createdAtUtc: string;
  approvedAtUtc: string | null;
  lines: MerchantSettlementLine[];
}
type SettlementRow = {
  batch_id: string; merchant_id: string; currency: string;
  period_start: Date | string; period_end: Date | string;
  status: "draft" | "approved"; created_at: Date | string;
  approved_at: Date | string | null;
  line_id: string | null; order_id: string | null; suborder_id: string | null;
  branch_id: string | null; contract_reference: string | null;
  gross_minor: string | number | null; deductions_minor: string | number | null;
  net_minor: string | number | null; deduction_breakdown: unknown;
};

function safeMinor(value: string | number | null, field: string): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`invalid_merchant_settlement_${field}`);
  }
  return amount;
}
function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_merchant_settlement_timestamp");
  return date.toISOString();
}
function breakdown(value: unknown): Array<{ code: string; amountMinor: number }> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new Error("invalid_merchant_settlement_deduction_breakdown");
  return parsed.map(item => {
    if (!item || typeof item !== "object" ||
        typeof (item as { code?: unknown }).code !== "string") {
      throw new Error("invalid_merchant_settlement_deduction_breakdown");
    }
    const row = item as { code: string; amountMinor?: unknown };
    return { code: row.code, amountMinor: safeMinor(row.amountMinor as string | number, "deduction") };
  });
}

/** Read-only merchant-scoped settlement projection; it never approves a batch or initiates a payout. */
export class PostgresMerchantSettlementReader {
  constructor(private readonly pool: PostgresPool) {}

  async list(input: {
    tenantId: string; merchantId: string; status?: "draft" | "approved"; limit?: number;
  }): Promise<MerchantSettlementBatchSummary[]> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("invalid_merchant_settlement_limit");
    }
    const result = await this.pool.query<{
      batch_id: string; merchant_id: string; currency: string;
      period_start: Date | string; period_end: Date | string;
      status: "draft" | "approved"; created_at: Date | string;
      approved_at: Date | string | null; line_count: string | number;
      gross_minor: string | number; deductions_minor: string | number; net_minor: string | number;
    }>(
      `SELECT b.id AS batch_id,b.merchant_id,b.currency,b.period_start,b.period_end,
              b.status,b.created_at,b.approved_at,COUNT(l.id) AS line_count,
              COALESCE(SUM(l.gross_minor),0) AS gross_minor,
              COALESCE(SUM(l.deductions_minor),0) AS deductions_minor,
              COALESCE(SUM(l.net_minor),0) AS net_minor
       FROM merchant_settlement_batches b
       LEFT JOIN merchant_settlement_lines l
         ON l.tenant_id=b.tenant_id AND l.batch_id=b.id
       WHERE b.tenant_id=$1 AND b.merchant_id=$2 AND ($3::text IS NULL OR b.status=$3)
       GROUP BY b.tenant_id,b.id
       ORDER BY b.created_at DESC,b.id DESC
       LIMIT $4`,
      [input.tenantId,input.merchantId,input.status ?? null,limit]
    );
    return result.rows.map(row => ({
      id: row.batch_id, merchantId: row.merchant_id, currency: row.currency,
      periodStartUtc: iso(row.period_start), periodEndUtc: iso(row.period_end),
      status: row.status, createdAtUtc: iso(row.created_at),
      approvedAtUtc: row.approved_at === null ? null : iso(row.approved_at),
      lineCount: safeMinor(row.line_count, "line_count"),
      grossMinor: safeMinor(row.gross_minor, "gross"),
      deductionsMinor: safeMinor(row.deductions_minor, "deductions"),
      netMinor: safeMinor(row.net_minor, "net")
    }));
  }

  async get(input: {
    tenantId: string; merchantId: string; batchId: string;
  }): Promise<MerchantSettlementBatch | null> {
    const result = await this.pool.query<SettlementRow>(
      `SELECT b.id AS batch_id,b.merchant_id,b.currency,b.period_start,b.period_end,
              b.status,b.created_at,b.approved_at,
              l.id AS line_id,l.order_id,l.suborder_id,l.branch_id,l.contract_reference,
              l.gross_minor,l.deductions_minor,l.net_minor,l.deduction_breakdown
       FROM merchant_settlement_batches b
       LEFT JOIN merchant_settlement_lines l
         ON l.tenant_id=b.tenant_id AND l.batch_id=b.id
       WHERE b.tenant_id=$1 AND b.merchant_id=$2 AND b.id=$3
       ORDER BY l.created_at,l.id`,
      [input.tenantId,input.merchantId,input.batchId]
    );
    if (result.rows.length === 0) return null;
    const first = result.rows[0]!;
    return {
      id: first.batch_id,
      merchantId: first.merchant_id,
      currency: first.currency,
      periodStartUtc: iso(first.period_start),
      periodEndUtc: iso(first.period_end),
      status: first.status,
      createdAtUtc: iso(first.created_at),
      approvedAtUtc: first.approved_at === null ? null : iso(first.approved_at),
      lines: result.rows.flatMap(row => row.line_id === null ? [] : [{
        id: row.line_id!,
        orderId: row.order_id!,
        suborderId: row.suborder_id!,
        branchId: row.branch_id!,
        contractReference: row.contract_reference!,
        grossMinor: safeMinor(row.gross_minor, "gross"),
        deductionsMinor: safeMinor(row.deductions_minor, "deductions"),
        netMinor: safeMinor(row.net_minor, "net"),
        deductionBreakdown: breakdown(row.deduction_breakdown)
      }])
    };
  }
}
