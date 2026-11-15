import { PostgresFinancialJournalService } from "./postgres-financial-journal-service.js";
import type { PostgresPool } from "./postgres-iam-store.js";

export type VerifiedCaptureJournalProjectionResult =
  | { outcome: "posted" | "duplicate"; journalId: string; captureId: string }
  | { outcome: "identity_collision"; captureId: string }
  | { outcome: "capture_not_found" }
  | { outcome: "accounts_not_configured"; captureId: string };

type CaptureRow = {
  id: string;
  tenant_id: string;
  amount_minor: string | number;
  currency: string;
  captured_at: Date | string;
  provider_key: string;
  provider_event_id: string;
};
type AccountRow = {
  id: string;
  account_code: string;
  account_type: "asset" | "liability" | "equity" | "revenue" | "expense";
  currency: string;
};

/**
 * Projects verified capture evidence into the accounting journal.
 * This does not charge, settle, refund, or move funds. Missing tenant accounts
 * fail closed and must be provisioned by an authorized finance administrator.
 */
export class PostgresVerifiedCaptureFinancialJournalProjector {
  private readonly journals: PostgresFinancialJournalService;

  constructor(
    private readonly pool: PostgresPool,
    options: {
      clearingAccountCode?: string;
      heldFundsAccountCode?: string;
      createId?: () => string;
    } = {}
  ) {
    this.clearingAccountCode = options.clearingAccountCode ?? "PAYMENT_CLEARING";
    this.heldFundsAccountCode = options.heldFundsAccountCode ?? "CUSTOMER_FUNDS_HELD";
    if (!/^[A-Z0-9_]{1,80}$/.test(this.clearingAccountCode) ||
        !/^[A-Z0-9_]{1,80}$/.test(this.heldFundsAccountCode) ||
        this.clearingAccountCode === this.heldFundsAccountCode) {
      throw new Error("INVALID_CAPTURE_FINANCIAL_ACCOUNT_MAPPING");
    }
    this.journals = new PostgresFinancialJournalService(pool, options.createId);
  }

  private readonly clearingAccountCode: string;
  private readonly heldFundsAccountCode: string;

  async project(captureId: string): Promise<VerifiedCaptureJournalProjectionResult> {
    if (typeof captureId !== "string" || !captureId.trim() || captureId.length > 200) {
      throw new Error("INVALID_VERIFIED_CAPTURE_ID");
    }
    const captureResult = await this.pool.query<CaptureRow>(
      `SELECT id,tenant_id,amount_minor,currency,captured_at,provider_key,provider_event_id
       FROM verified_order_payment_captures WHERE id=$1`,
      [captureId]
    );
    if (captureResult.rowCount !== 1) return { outcome: "capture_not_found" };
    const capture = captureResult.rows[0]!;
    const amountMinor = Number(capture.amount_minor);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
        !/^[A-Z]{3}$/.test(capture.currency)) {
      throw new Error("INVALID_VERIFIED_CAPTURE_FINANCIAL_EVIDENCE");
    }

    const accountResult = await this.pool.query<AccountRow>(
      `SELECT id,account_code,account_type,currency
       FROM financial_accounts
       WHERE tenant_id=$1 AND currency=$2 AND is_active=true
         AND account_code=ANY($3::text[])`,
      [capture.tenant_id,capture.currency,[this.clearingAccountCode,this.heldFundsAccountCode]]
    );
    const clearing = accountResult.rows.find(row => row.account_code === this.clearingAccountCode);
    const heldFunds = accountResult.rows.find(row => row.account_code === this.heldFundsAccountCode);
    if (!clearing || !heldFunds) {
      return { outcome: "accounts_not_configured", captureId: capture.id };
    }
    if (clearing.account_type !== "asset" || heldFunds.account_type !== "liability" ||
        clearing.currency !== capture.currency || heldFunds.currency !== capture.currency ||
        clearing.id === heldFunds.id) {
      throw new Error("INVALID_CAPTURE_FINANCIAL_ACCOUNT_CONFIGURATION");
    }

    const posted = await this.journals.post({
      tenantId: capture.tenant_id,
      idempotencyKey: `verified-capture-journal:${capture.id}`,
      sourceType: "verified_payment_capture",
      sourceReference: capture.id,
      currency: capture.currency,
      description: `Verified payment capture ${capture.provider_key} / ${capture.provider_event_id}`,
      occurredAtUtc: capture.captured_at instanceof Date
        ? capture.captured_at.toISOString()
        : new Date(capture.captured_at).toISOString(),
      lines: [
        { accountId: clearing.id, debitMinor: amountMinor, memo: "Payment provider clearing receivable" },
        { accountId: heldFunds.id, creditMinor: amountMinor, memo: "Customer funds held pending order fulfilment" }
      ]
    });
    if (posted.outcome === "identity_collision") {
      return { outcome: "identity_collision", captureId: capture.id };
    }
    return { outcome: posted.outcome, journalId: posted.journalId, captureId: capture.id };
  }
}
