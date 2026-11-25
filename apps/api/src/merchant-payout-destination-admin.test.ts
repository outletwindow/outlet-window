import {afterEach,describe,expect,it,vi} from "vitest";
import type {FastifyInstance} from "fastify";
import type {Actor} from "../../../packages/domain/src/authorization.js";
import type {AuditEvent} from "../../../packages/domain/src/audit.js";
import {buildApp} from "./app.js";

describe("platform merchant payout destination administration",()=>{
  const apps:FastifyInstance[]=[];
  afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
  const admin:Actor={id:"platform-admin",role:"platform_admin",active:true,grants:[
    {resource:"platform.merchant_payout_destination",actions:["read","create","approve","manage_access"],scope:{platform:true}}
  ]};
  const destination={id:"destination-1",tenantId:"tenant-1",merchantId:"merchant-1",
    providerKey:"moyasar",currency:"SAR",providerEntityRegistryId:"entity-1",
    verificationStatus:"pending" as const,createdBy:"creator-1",
    createdAt:"2026-11-25T10:00:00.000Z",verifiedBy:null,verifiedAt:null};

  it("registers pending destinations without returning or auditing the vault reference",async()=>{
    const register=vi.fn(async()=>({outcome:"created" as const,destination}));
    const append=vi.fn(async(_event:AuditEvent)=>"inserted" as const);
    const app=buildApp({resolveActor:async()=>admin,merchantPayoutDestinations:{
      register,list:vi.fn(async()=>[]),verify:vi.fn(),revoke:vi.fn()
    },auditEvents:{append}});
    apps.push(app);await app.ready();
    const secret="vault://opaque-reference-value";
    const response=await app.inject({method:"POST",url:"/api/v1/platform/payout-destinations",payload:{
      tenantId:"tenant-1",merchantId:"merchant-1",providerKey:"moyasar",currency:"SAR",
      providerEntityRegistryId:"entity-1",vaultReference:secret
    }});
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(secret);
    expect(JSON.stringify(append.mock.calls)).not.toContain(secret);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({vaultReference:secret,actorId:"platform-admin"}));
  });

  it("rejects self-approval and records an audit outcome",async()=>{
    const verify=vi.fn(async()=>({outcome:"self_approval" as const}));
    const append=vi.fn(async(_event:AuditEvent)=>"inserted" as const);
    const app=buildApp({resolveActor:async()=>admin,merchantPayoutDestinations:{
      register:vi.fn(),list:vi.fn(async()=>[]),verify,revoke:vi.fn()
    },auditEvents:{append}});
    apps.push(app);await app.ready();
    const response=await app.inject({method:"POST",url:"/api/v1/platform/payout-destinations/destination-1/verify"});
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("payout_destination_self_approval_forbidden");
    expect(verify).toHaveBeenCalledWith({destinationId:"destination-1",actorId:"platform-admin"});
    expect(append).toHaveBeenCalledTimes(1);
  });
});
