import { describe, expect, it, vi } from "vitest";
import type { PostgresPool } from "./postgres-iam-store.js";
import { PostgresPaymentIntentStore } from "./postgres-payment-intent-store.js";

const input={
  tenantId:"tenant-1",orderId:"order-1",providerKey:"psp-a",
  providerPaymentReference:"provider-ref-1",amountMinor:12500,currency:"SAR",
  idempotencyKey:"intent-idempotency-1",expiresAtUtc:"2026-11-09T12:15:00.000Z"
};
const now=()=>new Date("2026-11-09T12:00:00.000Z");

describe("PostgreSQL server-owned payment intents",()=>{
  it("records a trusted provider reference with a server-generated id",async()=>{
    const query=vi.fn(async(sql:string)=>sql.includes("INSERT")
      ? {rows:[{id:"intent-1"}],rowCount:1}:{rows:[],rowCount:0});
    const store=new PostgresPaymentIntentStore({query,connect:vi.fn()} as unknown as PostgresPool,()=>"intent-1",now);
    await expect(store.recordCreatedIntent(input)).resolves.toEqual({outcome:"created",intentId:"intent-1"});
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT DO NOTHING");
  });

  it("resolves only exact provider reference, amount and currency while payable and unexpired",async()=>{
    const query=vi.fn(async(_sql:string,_values?:readonly unknown[])=>({rows:[{tenant_id:"tenant-1",order_id:"order-1"}],rowCount:1}));
    const store=new PostgresPaymentIntentStore({query,connect:vi.fn()} as unknown as PostgresPool,undefined,now);
    await expect(store.findExpectedOrder({
      providerKey:"psp-a",providerPaymentReference:"provider-ref-1",amountMinor:12500,currency:"SAR"
    })).resolves.toEqual({tenantId:"tenant-1",orderId:"order-1"});
    expect(query.mock.calls[0]?.[0]).toContain("i.amount_minor=$3 AND i.currency=$4");
  });

  it("fails closed when no exact mapping exists",async()=>{
    const query=vi.fn(async(_sql:string,_values?:readonly unknown[])=>({rows:[],rowCount:0}));
    const store=new PostgresPaymentIntentStore({query,connect:vi.fn()} as unknown as PostgresPool,undefined,now);
    await expect(store.findExpectedOrder({
      providerKey:"psp-a",providerPaymentReference:"wrong-ref",amountMinor:12500,currency:"SAR"
    })).resolves.toBeNull();
  });

  it("rejects malformed or expired intent input before database access",async()=>{
    const query=vi.fn(async(_sql:string,_values?:readonly unknown[])=>({rows:[],rowCount:0}));
    const store=new PostgresPaymentIntentStore({query,connect:vi.fn()} as unknown as PostgresPool,undefined,now);
    await expect(store.recordCreatedIntent({...input,amountMinor:0})).rejects.toThrow("INVALID_PROVIDER_PAYMENT_INTENT");
    await expect(store.recordCreatedIntent({...input,expiresAtUtc:"2026-11-08T12:00:00.000Z"}))
      .rejects.toThrow("INVALID_PROVIDER_PAYMENT_INTENT");
    expect(query).not.toHaveBeenCalled();
  });
});
