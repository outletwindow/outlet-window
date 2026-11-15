import { describe, expect, it, vi } from "vitest";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";
import { PostgresCaptureFinancialAccountProvisioner } from "./postgres-capture-financial-account-provisioner.js";

const rows = [
  { id: "clearing-1", account_code: "PAYMENT_CLEARING", account_type: "asset" as const, currency: "SAR", is_active: true },
  { id: "held-1", account_code: "CUSTOMER_FUNDS_HELD", account_type: "liability" as const, currency: "SAR", is_active: true },
  { id: "payable-1", account_code: "MERCHANT_PAYABLE", account_type: "liability" as const, currency: "SAR", is_active: true }
];

function setup(query: ReturnType<typeof vi.fn>) {
  const client = { query, release: vi.fn() } as unknown as PostgresClient;
  const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } as unknown as PostgresPool;
  return { provisioner: new PostgresCaptureFinancialAccountProvisioner(pool, (() => {
    let id = 0;
    return () => `account-${++id}`;
  })()), client, pool };
}

describe("PostgresCaptureFinancialAccountProvisioner", () => {
  it("provisions tenant-scoped clearing and held-funds accounts atomically", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // clearing account
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // held funds account
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // merchant payable account
      .mockResolvedValueOnce({ rows, rowCount: 3 }) // validate definitions
      .mockResolvedValueOnce({ rows: [], rowCount: null }); // COMMIT
    const { provisioner, client } = setup(query);

    await expect(provisioner.provision({ tenantId: "tenant-1", currency: "SAR" })).resolves.toEqual({
      clearingAccountId: "clearing-1", heldFundsAccountId: "held-1", merchantPayableAccountId: "payable-1", currency: "SAR"
    });
    expect(query.mock.calls[1]?.[0]).toContain("'PAYMENT_CLEARING'");
    expect(query.mock.calls[2]?.[0]).toContain("'CUSTOMER_FUNDS_HELD'");
    expect(query.mock.calls[1]?.[0]).toContain("ON CONFLICT (tenant_id,account_code,currency) DO NOTHING");
    expect(query.mock.calls[3]?.[0]).toContain("MERCHANT_PAYABLE");
    expect(query.mock.calls[4]?.[1]).toEqual(["tenant-1", "SAR", ["PAYMENT_CLEARING", "CUSTOMER_FUNDS_HELD", "MERCHANT_PAYABLE"]]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("is idempotent and leaves pre-existing account definitions unchanged", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows, rowCount: 3 })
      .mockResolvedValueOnce({ rows: [], rowCount: null });
    const { provisioner } = setup(query);
    await expect(provisioner.provision({ tenantId: "tenant-1", currency: "SAR" }))
      .resolves.toMatchObject({ clearingAccountId: "clearing-1", heldFundsAccountId: "held-1", merchantPayableAccountId: "payable-1" });
    expect(query.mock.calls[1]?.[0]).toContain("DO NOTHING");
    expect(query.mock.calls[2]?.[0]).toContain("DO NOTHING");
  });

  it("fails closed and rolls back if an existing account has the wrong classification", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [rows[0], { ...rows[1], account_type: "revenue" }, rows[2]], rowCount: 3 })
      .mockResolvedValueOnce({ rows: [], rowCount: null }); // ROLLBACK
    const { provisioner, client } = setup(query);
    await expect(provisioner.provision({ tenantId: "tenant-1", currency: "SAR" }))
      .rejects.toThrow("CAPTURE_FINANCIAL_ACCOUNT_CONFIGURATION_CONFLICT");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects malformed tenant or currency before database access", async () => {
    const query = vi.fn();
    const { provisioner, pool } = setup(query);
    await expect(provisioner.provision({ tenantId: "", currency: "SAR" }))
      .rejects.toThrow("INVALID_CAPTURE_FINANCIAL_ACCOUNT_PROVISIONING");
    await expect(provisioner.provision({ tenantId: "tenant-1", currency: "sar" }))
      .rejects.toThrow("INVALID_CAPTURE_FINANCIAL_ACCOUNT_PROVISIONING");
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
