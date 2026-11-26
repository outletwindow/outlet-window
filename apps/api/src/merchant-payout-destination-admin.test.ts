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
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type:"payout_destination.verification_rejected",outcome:"failure",
      metadata:expect.objectContaining({reason:"self_approval"})
    }));
  });

  it("records the authenticated actor when revoking a payout destination",async()=>{
    const revoke=vi.fn(async()=>({outcome:"revoked" as const}));
    const append=vi.fn(async(_event:AuditEvent)=>"inserted" as const);
    const app=buildApp({resolveActor:async()=>admin,merchantPayoutDestinations:{
      register:vi.fn(),list:vi.fn(async()=>[]),verify:vi.fn(),revoke
    },auditEvents:{append}});
    apps.push(app);await app.ready();
    const response=await app.inject({method:"POST",url:"/api/v1/platform/payout-destinations/destination-1/revoke"});
    expect(response.statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledWith({destinationId:"destination-1",actorId:"platform-admin"});
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type:"payout_destination.revoked",outcome:"success",resourceId:"destination-1"
    }));
  });
  it("lists exception cases for finance reviewers",async()=>{
    const finance:Actor={id:"finance-1",role:"finance",active:true,grants:[
      {resource:"platform.merchant_payout_exception_case",actions:["read","approve"],scope:{platform:true}}
    ]};
    const exceptionCase={id:"case-1",tenantId:"tenant-1",outboxId:"outbox-1",providerKey:"moyasar",
      providerEventId:"evt-1",providerReference:"payout-1",eventType:"payout_returned" as const,
      amountMinor:12500,currency:"SAR",reviewStatus:"open" as const,reviewStartedBy:null,reviewStartedAt:null,
      resolutionCode:null,resolutionNote:null,resolvedBy:null,resolvedAt:null,createdAt:"2026-11-26T10:00:00.000Z"};
    const list=vi.fn(async()=>[exceptionCase]);
    const app=buildApp({resolveActor:async()=>finance,merchantPayoutExceptionCases:{
      list,startReview:vi.fn(),resolve:vi.fn()
    }});
    apps.push(app);await app.ready();
    const response=await app.inject({method:"GET",url:"/api/v1/platform/payout-exception-cases?status=open"});
    expect(response.statusCode).toBe(200);
    expect(response.json().cases).toEqual([exceptionCase]);
  });

  it("requires a different finance actor to resolve a case after review",async()=>{
    const finance:Actor={id:"finance-2",role:"finance",active:true,grants:[
      {resource:"platform.merchant_payout_exception_case",actions:["read","approve"],scope:{platform:true}}
    ]};
    const resolve=vi.fn(async()=>({outcome:"reviewer_cannot_resolve" as const}));
    const append=vi.fn(async(_event:AuditEvent)=>"inserted" as const);
    const app=buildApp({resolveActor:async()=>finance,merchantPayoutExceptionCases:{
      list:vi.fn(async()=>[]),startReview:vi.fn(),resolve
    },auditEvents:{append}});
    apps.push(app);await app.ready();
    const response=await app.inject({method:"POST",url:"/api/v1/platform/payout-exception-cases/case-1/resolve",
      payload:{resolutionCode:"BANK_RETURN_CONFIRMED",resolutionNote:"Confirmed with provider"}});
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("payout_exception_independent_reviewer_required");
    expect(resolve).toHaveBeenCalledWith({caseId:"case-1",actorId:"finance-2",
      resolutionCode:"BANK_RETURN_CONFIRMED",resolutionNote:"Confirmed with provider"});
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type:"payout_exception.resolution_rejected",outcome:"failure"
    }));
  });

  it("rejects unknown resolution fields",async()=>{
    const finance:Actor={id:"finance-3",role:"finance",active:true,grants:[
      {resource:"platform.merchant_payout_exception_case",actions:["read","approve"],scope:{platform:true}}
    ]};
    const app=buildApp({resolveActor:async()=>finance,merchantPayoutExceptionCases:{
      list:vi.fn(async()=>[]),startReview:vi.fn(),resolve:vi.fn()
    },auditEvents:{append:vi.fn(async(_event:AuditEvent)=>"inserted" as const)}});
    apps.push(app);await app.ready();
    const response=await app.inject({method:"POST",url:"/api/v1/platform/payout-exception-cases/case-1/resolve",
      payload:{resolutionCode:"VALID_CODE",reverseTransfer:true}});
    expect(response.statusCode).toBe(400);
  });

});
