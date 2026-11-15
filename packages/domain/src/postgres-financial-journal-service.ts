import { randomUUID } from "node:crypto";
import type { PostgresPool, PostgresClient } from "./postgres-iam-store.js";

export interface FinancialJournalLineInput {
  accountId: string;
  debitMinor?: number;
  creditMinor?: number;
  memo?: string;
}
export interface PostFinancialJournalInput {
  tenantId: string;
  idempotencyKey: string;
  sourceType: string;
  sourceReference: string;
  currency: string;
  description: string;
  occurredAtUtc: string;
  lines: readonly FinancialJournalLineInput[];
}
export type FinancialJournalWriteResult =
  | { outcome: "posted"; journalId: string }
  | { outcome: "duplicate"; journalId: string }
  | { outcome: "identity_collision" };

type ExistingJournalRow = {
  id: string; tenant_id: string; idempotency_key: string; source_type: string;
  source_reference: string; currency: string; description: string;
  occurred_at: Date | string; status: "draft" | "posted";
};
type ExistingLineRow = {
  account_id: string; currency: string; line_number: number;
  debit_minor: string | number; credit_minor: string | number; memo: string | null;
};

function canonicalLines(lines: readonly FinancialJournalLineInput[]) {
  return lines.map((line, index) => ({
    accountId: line.accountId,
    lineNumber: index + 1,
    debitMinor: line.debitMinor ?? 0,
    creditMinor: line.creditMinor ?? 0,
    memo: line.memo ?? null
  }));
}
function sameInstant(a: Date | string, b: string): boolean {
  return new Date(a).toISOString() === new Date(b).toISOString();
}

/**
 * Posts a balanced, tenant- and currency-scoped journal in one PostgreSQL transaction.
 * It records accounting evidence only; it does not capture, refund, or move money.
 */
export class PostgresFinancialJournalService {
  constructor(
    private readonly pool: PostgresPool,
    private readonly createId: () => string = randomUUID
  ) {}

  async post(input: PostFinancialJournalInput): Promise<FinancialJournalWriteResult> {
    if (!input.tenantId.trim() ||
        !/^[a-zA-Z0-9._:-]{8,240}$/.test(input.idempotencyKey) ||
        !/^[a-zA-Z0-9._-]{1,80}$/.test(input.sourceType) ||
        !input.sourceReference.trim() || input.sourceReference.length > 240 ||
        !/^[A-Z]{3}$/.test(input.currency) ||
        !input.description.trim() || input.description.length > 500 ||
        !Number.isFinite(Date.parse(input.occurredAtUtc)) ||
        !Array.isArray(input.lines) || input.lines.length < 2 || input.lines.length > 500) {
      throw new Error("INVALID_FINANCIAL_JOURNAL");
    }

    const lines = canonicalLines(input.lines);
    let debitTotal = 0;
    let creditTotal = 0;
    for (const line of lines) {
      if (!line.accountId.trim() ||
          !Number.isSafeInteger(line.debitMinor) || !Number.isSafeInteger(line.creditMinor) ||
          line.debitMinor < 0 || line.creditMinor < 0 ||
          ((line.debitMinor > 0) === (line.creditMinor > 0)) ||
          (line.memo !== null && line.memo.length > 500)) {
        throw new Error("INVALID_FINANCIAL_JOURNAL_LINE");
      }
      debitTotal += line.debitMinor;
      creditTotal += line.creditMinor;
      if (!Number.isSafeInteger(debitTotal) || !Number.isSafeInteger(creditTotal)) {
        throw new Error("FINANCIAL_JOURNAL_TOTAL_OUT_OF_RANGE");
      }
    }
    if (debitTotal <= 0 || debitTotal !== creditTotal) {
      throw new Error("FINANCIAL_JOURNAL_NOT_BALANCED");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const journalId = this.createId();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO financial_journals
         (id,tenant_id,idempotency_key,source_type,source_reference,currency,description,status,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8)
         ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
         RETURNING id`,
        [journalId,input.tenantId,input.idempotencyKey,input.sourceType,input.sourceReference,
          input.currency,input.description,input.occurredAtUtc]
      );

      if (inserted.rows.length === 0) {
        const existing = await client.query<ExistingJournalRow>(
          `SELECT id,tenant_id,idempotency_key,source_type,source_reference,currency,
                  description,occurred_at,status
           FROM financial_journals WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [input.tenantId,input.idempotencyKey]
        );
        if (existing.rows.length !== 1) throw new Error("FINANCIAL_JOURNAL_IDEMPOTENCY_LOOKUP_FAILED");
        const row = existing.rows[0]!;
        const existingLines = await client.query<ExistingLineRow>(
          `SELECT account_id,currency,line_number,debit_minor,credit_minor,memo
           FROM financial_journal_lines WHERE tenant_id=$1 AND journal_id=$2
           ORDER BY line_number`,
          [input.tenantId,row.id]
        );
        const sameHeader = row.source_type === input.sourceType &&
          row.source_reference === input.sourceReference && row.currency === input.currency &&
          row.description === input.description && sameInstant(row.occurred_at,input.occurredAtUtc);
        const actualLines = existingLines.rows.map(line => ({
          accountId: line.account_id, lineNumber: Number(line.line_number),
          debitMinor: Number(line.debit_minor), creditMinor: Number(line.credit_minor),
          memo: line.memo
        }));
        const sameLines = JSON.stringify(actualLines) === JSON.stringify(lines);
        await client.query("COMMIT");
        return sameHeader && sameLines && row.status === "posted"
          ? { outcome: "duplicate", journalId: row.id }
          : { outcome: "identity_collision" };
      }

      for (const line of lines) {
        await client.query(
          `INSERT INTO financial_journal_lines
           (id,tenant_id,journal_id,account_id,currency,line_number,debit_minor,credit_minor,memo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [this.createId(),input.tenantId,journalId,line.accountId,input.currency,
            line.lineNumber,line.debitMinor,line.creditMinor,line.memo]
        );
      }
      const posted = await client.query(
        "UPDATE financial_journals SET status='posted' WHERE tenant_id=$1 AND id=$2 AND status='draft' RETURNING id",
        [input.tenantId,journalId]
      );
      if (posted.rows.length !== 1) throw new Error("FINANCIAL_JOURNAL_POST_FAILED");
      await client.query("COMMIT");
      return { outcome: "posted", journalId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
