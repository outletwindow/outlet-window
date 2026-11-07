import type { PostgresQueryable } from "./postgres-iam-store.js";

export interface CreateMerchantBranchInput {
  merchantId: string;
  branchId: string;
  displayName: string;
  cityCode: string;
  address?: Readonly<Record<string, unknown>>;
}

export type CreateMerchantBranchResult = "created" | "already_exists" | "merchant_not_found" | "merchant_inactive";

export interface MerchantBranchWriter {
  createBranch(input: CreateMerchantBranchInput): Promise<CreateMerchantBranchResult>;
}

/** PostgreSQL writer. Merchant scope is always part of the insert and conflict key. */
export class PostgresMerchantBranchWriter implements MerchantBranchWriter {
  constructor(private readonly database: PostgresQueryable) {}

  async createBranch(input: CreateMerchantBranchInput): Promise<CreateMerchantBranchResult> {
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO merchant_branches
         (id, merchant_id, display_name, city_code, address, status)
       SELECT $1, m.id, $3, $4, $5::jsonb, 'active'
       FROM merchants m
       WHERE m.id = $2 AND m.status = 'active'
       ON CONFLICT (merchant_id, id) DO NOTHING
       RETURNING id`,
      [input.branchId, input.merchantId, input.displayName, input.cityCode,
        JSON.stringify(input.address ?? {})]
    );
    if (result.rowCount === 1) return "created";
    const merchant = await this.database.query<{ id: string; status: string }>(
      "SELECT id, status FROM merchants WHERE id = $1",
      [input.merchantId]
    );
    if (!merchant.rowCount) return "merchant_not_found";
    if (merchant.rows[0]?.status !== "active") return "merchant_inactive";
    return "already_exists";
  }
}
