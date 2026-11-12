import type { PostgresQueryable } from "./postgres-iam-store.js";

export interface MerchantBranchSummary {
  merchantId: string;
  branchId: string;
  displayName: string;
  status: "active" | "inactive";
}

/** Read-only tenant-scoped merchant branch adapter. */
export class PostgresMerchantBranchReader {
  constructor(private readonly database: PostgresQueryable) {}

  async findBranchSummary(input: {
    merchantId: string;
    branchId: string;
  }): Promise<MerchantBranchSummary | null> {
    const result = await this.database.query<{
      merchant_id: string;
      id: string;
      display_name: string;
      status: "active" | "inactive";
    }>(
      `SELECT merchant_id, id, display_name, status
       FROM merchant_branches
       WHERE merchant_id = $1 AND id = $2
       LIMIT 1`,
      [input.merchantId, input.branchId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      merchantId: row.merchant_id,
      branchId: row.id,
      displayName: row.display_name,
      status: row.status
    };
  }
}
