import {describe,expect,it} from "vitest";
import {moyasarMerchantPayoutExceptionEventDecoder} from "./moyasar-merchant-payout-exception-webhook.js";
import {MoyasarMerchantPayoutExceptionWebhookProcessor} from "./moyasar-merchant-payout-exception-processor.js";

const secret="sandbox-shared-secret";
function fixture(type:"merchant_payout_failed"|"merchant_payout_canceled"|"merchant_payout_returned"){
  const status=type==="merchant_payout_failed"?"failed":type==="merchant_payout_canceled"?"canceled":"returned";
  const payload={
    id:`evt-${status}-1`,type,created_at:"2026-11-25T10:00:00.000Z",
    secret_token:secret,account_name:"Outlet Window Platform",live:false,
    merchant_id:"merchant-123",entity_id:"entity-456",
    data:{id:"payout-789",status,amount:12500,currency:"SAR",
      metadata:{outlet_window_outbox_id:"outbox-123"}}
  };
  return {payload,rawBody:JSON.stringify(payload),headers:{
    "X-Event-ID":payload.id,"X-Event-Type":type,"X-Event-Secret":secret
  }};
}
describe("Moyasar payout exception webhook",()=>{
  it.each(["merchant_payout_failed","merchant_payout_canceled","merchant_payout_returned"] as const)(
    "decodes %s into an exception event only",type=>{
      const {rawBody}=fixture(type);
      expect(moyasarMerchantPayoutExceptionEventDecoder.decode(rawBody)).toMatchObject({
        providerEventId:`evt-${type.replace("merchant_payout_","")}-1`,
        outboxId:"outbox-123",providerReference:"payout-789",amountMinor:12500,
        currency:"SAR",merchantId:"merchant-123",entityId:"entity-456"
      });
    }
  );
  it("rejects paid events and status/type mismatches",()=>{
    const failed=fixture("merchant_payout_failed");
    expect(moyasarMerchantPayoutExceptionEventDecoder.decode(JSON.stringify({
      ...failed.payload,type:"merchant_payout_paid",data:{...failed.payload.data,status:"paid"}
    }))).toBeNull();
    expect(moyasarMerchantPayoutExceptionEventDecoder.decode(JSON.stringify({
      ...failed.payload,data:{...failed.payload.data,status:"returned"}
    }))).toBeNull();
  });
  it("verifies signed event and persists one exception case",async()=>{
    const {rawBody,headers}=fixture("merchant_payout_returned");
    let saved:unknown;
    const processor=new MoyasarMerchantPayoutExceptionWebhookProcessor({
      secretResolver:async()=>secret,expectedLiveMode:false,
      store:{recordVerified:async input=>{
        saved=input; return {outcome:"recorded" as const,caseId:"case-1"};
      }}
    });
    await expect(processor.process({rawBody,headers})).resolves.toEqual({outcome:"recorded",caseId:"case-1"});
    expect(saved).toMatchObject({
      providerKey:"moyasar",eventType:"payout_returned",
      event:{providerEventId:"evt-returned-1",outboxId:"outbox-123",amountMinor:12500}
    });
  });
  it("rejects an invalid signature and does not persist",async()=>{
    const {rawBody,headers}=fixture("merchant_payout_failed");
    let calls=0;
    const processor=new MoyasarMerchantPayoutExceptionWebhookProcessor({
      secretResolver:async()=>secret,expectedLiveMode:false,
      store:{recordVerified:async()=>{calls++;return {outcome:"recorded" as const,caseId:"x"};}}
    });
    await expect(processor.process({rawBody,headers:{...headers,"X-Event-Secret":"wrong"}}))
      .resolves.toEqual({outcome:"invalid_signature_or_event"});
    expect(calls).toBe(0);
  });
});
