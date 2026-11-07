import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresMerchantBranchWriter } from "../../../packages/domain/src/postgres-merchant-branch-writer.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgresMerchantBranchWriter", () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 3 }) : null;
  if (!pool) throw new Error("Pool must exist when DATABASE_URL is configured");
  const merchantId = `writer-merchant-${randomUUID()}`;
  const branchId = `writer-branch-${randomUUID()}`;
  const writer = new PostgresMerchantBranchWriter(pool);

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO merchants (id, legal_name, display_name, country_code, status) VALUES ($1,'Writer Merchant LLC','Writer Merchant','SA','active')",
      [merchantId]
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM merchant_branches WHERE merchant_id = $1", [merchantId]);
    await pool.query("DELETE FROM merchants WHERE id = $1", [merchantId]);
    await pool.end();
  });

  it("creates a branch for an active merchant", async () => {
    await expect(writer.createBranch({
      merchantId, branchId, displayName: "Jubail Main", cityCode: "JUB",
      address: { district: "Al Fanateer" }
    })).resolves.toBe("created");
  });

  it("does not overwrite an existing branch", async () => {
    await expect(writer.createBranch({
      merchantId, branchId, displayName: "Changed Name", cityCode: "JUB"
    })).resolves.toBe("already_exists");
    const row = await pool.query<{ display_name: string }>(
      "SELECT display_name FROM merchant_branches WHERE merchant_id = $1 AND id = $2",
      [merchantId, branchId]
    );
    expect(row.rows[0]?.display_name).toBe("Jubail Main");
  });

  it("does not create branches for unknown merchants", async () => {
    await expect(writer.createBranch({
      merchantId: "missing-merchant", branchId: "branch-new",
      displayName: "Unknown", cityCode: "JUB"
    })).resolves.toBe("merchant_not_found");
  });
});
