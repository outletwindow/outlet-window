import { describe, expect, it, vi } from "vitest";
import type { PostgresPool, PostgresQueryResult } from "./postgres-iam-store.js";
import { PostgresMerchantPayoutProviderEntityRegistry } from "./postgres-merchant-payout-provider-entity-registry.js";

function fakePool(handler: (sql: string, values: readonly unknown[]) => PostgresQueryResult<unknown>) {
  const calls: Array<{sql:string;values:readonly unknown[]}> = [];
  const pool = {
    async query<Row>(sql:string, values:readonly unknown[] = []) {
      calls.push({sql,values});
      return handler(sql,values) as PostgresQueryResult<Row>;
    },
    connect: vi.fn()
  } as unknown as PostgresPool;
  return {pool,calls};
}
const row = {
  id:"entity-1",tenant_id:"tenant-1",merchant_id:"merchant-1",provider_key:"moyasar",
  provider_merchant_id:"pm-1",provider_entity_id:"pe-1",status:"active" as const,
  created_by:"admin-1",created_at:"2026-11-25T10:00:00.000Z",revoked_at:null
};

describe("PostgresMerchantPayoutProviderEntityRegistry", () => {
  it("registers only an active merchant in the supplied tenant", async () => {
    const fake=fakePool(sql => sql.includes("INSERT INTO merchant_payout_provider_entities")
      ? {rows:[row],rowCount:1} : {rows:[],rowCount:0});
    const result=await new PostgresMerchantPayoutProviderEntityRegistry(fake.pool).register({
      tenantId:"tenant-1",merchantId:"merchant-1",providerKey:"moyasar",
      providerMerchantId:"pm-1",providerEntityId:"pe-1",actorId:"admin-1"
    });
    expect(result.outcome).toBe("created");
    if(result.outcome==="created") expect(result.entity.tenantId).toBe("tenant-1");
    expect(fake.calls[0].sql).toContain("m.tenant_id=$2 AND m.id=$3 AND m.status='active'");
    expect(fake.calls[0].values.slice(1)).toEqual(["tenant-1", "merchant-1", "moyasar", "pm-1", "pe-1", "admin-1"]);
  });

  it("rejects duplicate active provider identities", async () => {
    const fake=fakePool(() => { const error=Object.assign(new Error("duplicate"),{code:"23505"}); throw error; });
    const result=await new PostgresMerchantPayoutProviderEntityRegistry(fake.pool).register({
      tenantId:"tenant-1",merchantId:"merchant-1",providerKey:"moyasar",
      providerMerchantId:"pm-1",providerEntityId:"pe-1",actorId:"admin-1"
    });
    expect(result).toEqual({outcome:"identity_conflict"});
  });

  it("revokes an active mapping but never deletes it", async () => {
    const fake=fakePool(sql => sql.startsWith("UPDATE")
      ? {rows:[{id:"entity-1"}],rowCount:1} : {rows:[],rowCount:0});
    const result=await new PostgresMerchantPayoutProviderEntityRegistry(fake.pool).revoke({
      entityId:"entity-1",actorId:"admin-1"
    });
    expect(result).toEqual({outcome:"revoked"});
    expect(fake.calls[0].sql).toContain("SET status='revoked',revoked_at=now()");
    expect(fake.calls[0].sql).not.toMatch(/DELETE/i);
  });

  it("returns not_found for a missing merchant", async () => {
    const fake=fakePool(() => ({rows:[],rowCount:0}));
    const result=await new PostgresMerchantPayoutProviderEntityRegistry(fake.pool).register({
      tenantId:"tenant-1",merchantId:"missing",providerKey:"moyasar",
      providerMerchantId:"pm-1",providerEntityId:"pe-1",actorId:"admin-1"
    });
    expect(result).toEqual({outcome:"merchant_not_found"});
  });
});
