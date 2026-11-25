import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Actor } from "../../../packages/domain/src/authorization.js";
import { buildApp } from "./app.js";

describe("platform payout provider entity administration", () => {
  const apps: FastifyInstance[]=[];
  afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
  const admin:Actor={
    id:"platform-admin",role:"platform_admin",active:true,
    grants:[{resource:"platform.merchant_payout_provider_entity",actions:["read","create","manage_access"],scope:{platform:true}}]
  };

  it("registers provider entity identifiers with audit and without enabling transfers",async()=>{
    const register=vi.fn(async()=>({outcome:"created" as const,entity:{
      id:"entity-1",tenantId:"tenant-1",merchantId:"merchant-1",providerKey:"moyasar",
      providerMerchantId:"pm-1",providerEntityId:"pe-1",status:"active" as const,
      createdBy:"platform-admin",createdAt:"2026-11-25T10:00:00.000Z",revokedAt:null
    }}));
    const append=vi.fn(async()=> "inserted" as const);
    const app=buildApp({resolveActor:async()=>admin,merchantPayoutProviderEntities:{register,revoke:vi.fn(),list:vi.fn(async()=>[])},auditEvents:{append}});
    apps.push(app);await app.ready();
    const response=await app.inject({method:"POST",url:"/api/v1/platform/payout-provider-entities",payload:{
      tenantId:"tenant-1",merchantId:"merchant-1",providerKey:"moyasar",providerMerchantId:"pm-1",providerEntityId:"pe-1"
    }});
    expect(response.statusCode).toBe(201);
    expect(response.json().transfersEnabled).toBe(false);
    expect(register).toHaveBeenCalledWith({tenantId:"tenant-1",merchantId:"merchant-1",providerKey:"moyasar",providerMerchantId:"pm-1",providerEntityId:"pe-1",actorId:"platform-admin"});
    expect(append).toHaveBeenCalledTimes(2);
  });

  it("denies merchant actors even if they submit valid provider identifiers",async()=>{
    const merchant:Actor={id:"merchant-user",role:"merchant_owner",active:true,grants:[]};
    const register=vi.fn();
    const app=buildApp({resolveActor:async()=>merchant,merchantPayoutProviderEntities:{register,revoke:vi.fn(),list:vi.fn(async()=>[])}});
    apps.push(app);await app.ready();
    const response=await app.inject({method:"POST",url:"/api/v1/platform/payout-provider-entities",payload:{
      tenantId:"tenant-1",merchantId:"merchant-1",providerKey:"moyasar",providerMerchantId:"pm-1",providerEntityId:"pe-1"
    }});
    expect(response.statusCode).toBe(403);
    expect(register).not.toHaveBeenCalled();
  });
});
