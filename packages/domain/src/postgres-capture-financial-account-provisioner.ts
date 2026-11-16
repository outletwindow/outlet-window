import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

export interface ProvisionCaptureAccountsInput {
  tenantId: string;
  currency: string;
}
export interface CaptureLedgerAccounts {
  clearingAccountId: string;
  heldFundsAccountId: string;
  merchantPayableAccountId: string;
  currency: string;
}
type AccountRow = {
  id: string;
  account_code: string;
  account_type: "asset" | "liability" | "equity" | "revenue" | "expense";
  currency: string;
  is_active: boolean;
};

/**
 * Explicitly provisions capture-clearing, customer-funds-held, and merchant-payable accounts.
 * Existing account definitions are never overwritten; incompatible definitions fail closed.
 */
export class PostgresCaptureFinancialAccountProvisioner {
  constructor(
    private readonly pool: PostgresPool,
    private readonly createId: () => string = randomUUID
  ) {}

  async provision(input: ProvisionCaptureAccountsInput): Promise<CaptureLedgerAccounts> {
    if (typeof input.tenantId !== "string" || !input.tenantId.trim() ||
        input.tenantId.length > 200 || typeof input.currency !== "string" ||
        !/^[A-Z]{3}$/.test(input.currency)) {
      throw new Error("INVALID_CAPTURE_FINANCIAL_ACCOUNT_PROVISIONING");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO financial_accounts
         (id,tenant_id,account_code,account_name,account_type,currency)
         VALUES ($1,$2,'PAYMENT_CLEARING','Payment provider clearing','asset',$3)
         ON CONFLICT (tenant_id,account_code,currency) DO NOTHING`,
        [this.createId(), input.tenantId, input.currency]
      );
      await client.query(
        `INSERT INTO financial_accounts
         (id,tenant_id,account_code,account_name,account_type,currency)
         VALUES ($1,$2,'CUSTOMER_FUNDS_HELD','Customer funds held','liability',$3)
         ON CONFLICT (tenant_id,account_code,currency) DO NOTHING`,
        [this.createId(), input.tenantId, input.currency]
      );
      await client.query(
        `INSERT INTO financial_accounts
         (id,tenant_id,account_code,account_name,account_type,currency)
         VALUES ($1,$2,'MERCHANT_PAYABLE','Merchant payable','liability',$3)
         ON CONFLICT (tenant_id,account_code,currency) DO NOTHING`,
        [this.createId(), input.tenantId, input.currency]
      );
      const result = await client.query<AccountRow>(
        `SELECT id,account_code,account_type,currency,is_active
         FROM financial_accounts
         WHERE tenant_id=$1 AND currency=$2
           AND account_code=ANY($3::text[])
         ORDER BY account_code FOR UPDATE`,
        [input.tenantId, input.currency, ["PAYMENT_CLEARING", "CUSTOMER_FUNDS_HELD", "MERCHANT_PAYABLE"]]
      );
      const clearing = result.rows.find(row => row.account_code === "PAYMENT_CLEARING");
      const heldFunds = result.rows.find(row => row.account_code === "CUSTOMER_FUNDS_HELD");
      const merchantPayable = result.rows.find(row => row.account_code === "MERCHANT_PAYABLE");
      if (result.rows.length !== 3 || !clearing || !heldFunds || !merchantPayable ||
          clearing.account_type !== "asset" || heldFunds.account_type !== "liability" || merchantPayable.account_type !== "liability" ||
          !clearing.is_active || !heldFunds.is_active || !merchantPayable.is_active ||
          clearing.currency !== input.currency || heldFunds.currency !== input.currency || merchantPayable.currency !== input.currency ||
          clearing.id === heldFunds.id || clearing.id === merchantPayable.id || heldFunds.id === merchantPayable.id) {
        throw new Error("CAPTURE_FINANCIAL_ACCOUNT_CONFIGURATION_CONFLICT");
      }
      await client.query("COMMIT");
      return {
        clearingAccountId: clearing.id,
        heldFundsAccountId: heldFunds.id,
        merchantPayableAccountId: merchantPayable.id,
        currency: input.currency
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
