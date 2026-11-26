import { randomUUID } from "node:crypto";
import type { MerchantPayoutConfirmationEvent } from "./merchant-payout-confirmation-webhook.js";
import { createMoyasarMerchantPayoutWebhookVerifier } from "./moyasar-merchant-payout-webhook.js";
import { moyasarMerchantPayoutExceptionEventDecoder } from "./moyasar-merchant-payout-exception-webhook.js";
import type { MerchantPayoutExceptionStore } from "./postgres-moyasar-merchant-payout-exception-store.js";

/** Signature-verifies and records failed/canceled/returned events without posting reversals. */
export class MoyasarMerchantPayoutExceptionWebhookProcessor {
  constructor(private readonly dependencies: {
    secretResolver:(providerKey:string)=>Promise<string|null>;
    store:MerchantPayoutExceptionStore;
    expectedLiveMode:boolean;
  }) {}

  async process(input:{rawBody:string;headers:Readonly<Record<string,string>>}):
    Promise<{outcome:"recorded"|"duplicate";caseId:string}|{outcome:"invalid_signature_or_event"|"provider_not_configured"}> {
    if(!input.rawBody || Buffer.byteLength(input.rawBody,"utf8")>65_536 ||
      !input.headers || Object.keys(input.headers).length>64) return {outcome:"invalid_signature_or_event"};
    let secret:string|null;
    try { secret=await this.dependencies.secretResolver("moyasar"); }
    catch { return {outcome:"provider_not_configured"}; }
    if(!secret) return {outcome:"provider_not_configured"};
    let verified=false;
    try {
      verified=await createMoyasarMerchantPayoutWebhookVerifier(this.dependencies.expectedLiveMode)
        .verify({rawBody:input.rawBody,headers:input.headers,secret});
    } catch { return {outcome:"invalid_signature_or_event"}; }
    if(!verified) return {outcome:"invalid_signature_or_event"};
    let event:MerchantPayoutConfirmationEvent|null;
    try { event=moyasarMerchantPayoutExceptionEventDecoder.decode(input.rawBody); }
    catch { return {outcome:"invalid_signature_or_event"}; }
    if(!event) return {outcome:"invalid_signature_or_event"};

    let parsed:unknown;
    try { parsed=JSON.parse(input.rawBody) as unknown; } catch { return {outcome:"invalid_signature_or_event"}; }
    if(typeof parsed!=="object" || parsed===null || !("type" in parsed) || typeof parsed.type!=="string") {
      return {outcome:"invalid_signature_or_event"};
    }
    const eventType=parsed.type==="merchant_payout_failed"?"payout_failed":
      parsed.type==="merchant_payout_canceled"?"payout_canceled":"payout_returned";
    return this.dependencies.store.recordVerified({
      eventRowId:randomUUID(),caseId:randomUUID(),providerKey:"moyasar",eventType,event
    });
  }
}
