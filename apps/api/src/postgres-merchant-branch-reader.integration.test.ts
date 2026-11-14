import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresMerchantBranchReader } from "../../../packages/domain/src/postgres-merchant-branch-reader.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgresMerchantBranchReader", () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 3 }) : null;
  if (!pool) throw new Error("Pool must exist when DATABASE_URL is configured");
  const merchantId = `merchant-${randomUUID()}`;
  const branchId = `branch-${randomUUID()}`;
  const reader = new PostgresMerchantBranchReader(pool);

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO merchants (id, legal_name, display_name, country_code, status) VALUES ($1,$2,$3,'SA','active')",
      [merchantId, "Integration Merchant LLC", "Integration Merchant"]
    );
    await pool.query(
      "INSERT INTO merchant_branches (id, merchant_id, display_name, city_code, status) VALUES ($1,$2,'Jubail Main','JUB','active')",
      [branchId, merchantId]
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM merchant_branches WHERE merchant_id = $1", [merchantId]);
    await pool.query("DELETE FROM merchants WHERE id = $1", [merchantId]);
    await pool.end();
  });

  it("returns only the requested merchant's branch", async () => {
    await expect(reader.findBranchSummary({ merchantId, branchId })).resolves.toEqual({
      merchantId, branchId, displayName: "Jubail Main", status: "active"
    });
  });

  it("does not leak a branch when the merchant scope does not match", async () => {
    await expect(reader.findBranchSummary({ merchantId: `other-${merchantId}`, branchId })).resolves.toBeNull();
  });

  it("returns null for unknown branches", async () => {
    await expect(reader.findBranchSummary({ merchantId, branchId: "missing-branch" })).resolves.toBeNull();
  });
});
