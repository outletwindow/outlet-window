import type { PostgresQueryable } from "./postgres-iam-store.js";

export interface CreateMerchantBranchInput {
  merchantId: string;
  branchId: string;
  displayName: string;
  cityCode: string;
  address?: Readonly<Record<string, unknown>>;
}

export type CreateMerchantBranchResult = "created" | "already_exists" | "merchant_not_found" | "merchant_inactive";
export type UpdateMerchantBranchResult = "updated" | "not_found" | "merchant_not_found" | "merchant_inactive";

export interface MerchantBranchWriter {
  createBranch(input: CreateMerchantBranchInput): Promise<CreateMerchantBranchResult>;
  updateBranch(input: {
    merchantId: string;
    branchId: string;
    displayName: string;
    cityCode: string;
    address?: Readonly<Record<string, unknown>>;
    status: "active" | "inactive";
  }): Promise<UpdateMerchantBranchResult>;
}

/** PostgreSQL writer. Every write is constrained by merchant ownership in SQL. */
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
      "SELECT id, status FROM merchants WHERE id = $1", [input.merchantId]
    );
    if (!merchant.rowCount) return "merchant_not_found";
    if (merchant.rows[0]?.status !== "active") return "merchant_inactive";
    return "already_exists";
  }

  async updateBranch(input: {
    merchantId: string;
    branchId: string;
    displayName: string;
    cityCode: string;
    address?: Readonly<Record<string, unknown>>;
    status: "active" | "inactive";
  }): Promise<UpdateMerchantBranchResult> {
    const result = await this.database.query<{ id: string }>(
      `UPDATE merchant_branches AS b
       SET display_name = $3, city_code = $4,
           address = COALESCE($5::jsonb, b.address),
           status = $6, updated_at = now()
       FROM merchants AS m
       WHERE b.merchant_id = $1 AND b.id = $2
         AND m.id = b.merchant_id AND m.status = 'active'
       RETURNING b.id`,
      [input.merchantId, input.branchId, input.displayName, input.cityCode,
        input.address === undefined ? null : JSON.stringify(input.address), input.status]
    );
    if (result.rowCount === 1) return "updated";
    const merchant = await this.database.query<{ status: string }>(
      "SELECT status FROM merchants WHERE id = $1", [input.merchantId]
    );
    if (!merchant.rowCount) return "merchant_not_found";
    return merchant.rows[0]?.status === "active" ? "not_found" : "merchant_inactive";
  }
}
