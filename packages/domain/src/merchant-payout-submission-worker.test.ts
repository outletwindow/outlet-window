import { describe, expect, it, vi } from "vitest";
import {
  MerchantPayoutSubmissionWorker,
  type MerchantPayoutDestinationVault,
  type MerchantPayoutProviderRegistry,
  type MerchantPayoutProviderResult
} from "./merchant-payout-submission-worker.js";
import type { PostgresMerchantPayoutProviderOutbox } from "./postgres-merchant-payout-provider-outbox.js";

const job = {
  outboxId: "outbox-1",tenantId: "tenant-1",payoutIntentId: "intent-1",
  merchantId: "merchant-1",destinationId: "destination-1",
  vaultReference: "vault://tenant/merchant/payout-destination",
  providerKey: "sandbox-provider",currency: "SAR",amountMinor: 12500,
  idempotencyKey: "payout-idempotency-1",attemptCount: 1
};
function makeStore() {
  const calls: Array<{method:string;input:unknown}> = [];
  const store = {
    async claimNext() { calls.push({method:"claimNext",input:null}); return job; },
    async recordSubmitted(input:unknown) { calls.push({method:"recordSubmitted",input}); return "submitted" as const; },
    async recordUnknown(input:unknown) { calls.push({method:"recordUnknown",input}); return "reconciliation_required" as const; },
    async recordRejected(input:unknown) { calls.push({method:"recordRejected",input}); return "failed" as const; },
    async recordRetry(input:unknown) { calls.push({method:"recordRetry",input}); return "rescheduled" as const; }
  };
  return {store:store as unknown as PostgresMerchantPayoutProviderOutbox,calls};
}
function makeWorker(input:{
  providerResult?: MerchantPayoutProviderResult;
  providerThrows?: boolean;
  vaultThrows?: boolean;
}={}) {
  const fake=makeStore();
  const submit=vi.fn(async () => {
    if(input.providerThrows) throw new Error("network timeout");
    return input.providerResult ?? {status:"accepted" as const,providerReference:"provider-ref-1"};
  });
  const vault:MerchantPayoutDestinationVault={
    async resolve() {
      if(input.vaultThrows) throw new Error("vault unavailable");
      return {destinationToken:"opaque-provider-token"};
    }
  };
  const registry:MerchantPayoutProviderRegistry={
    get:()=>({submit})
  };
  const worker=new MerchantPayoutSubmissionWorker(fake.store,vault,registry,"worker-1","sandbox-provider");
  return {worker,calls:fake.calls,submit};
}

describe("MerchantPayoutSubmissionWorker",()=>{
  it("records provider acceptance as submitted, never as confirmed",async()=>{
    const {worker,calls,submit}=makeWorker();
    await expect(worker.runOnce()).resolves.toEqual({outcome:"submitted",outboxId:"outbox-1"});
    expect(submit).toHaveBeenCalledWith({
      payoutId:"intent-1",outboxId:"outbox-1",amountMinor:12500,currency:"SAR",
      idempotencyKey:"payout-idempotency-1",destinationToken:"opaque-provider-token"
    });
    expect(calls.some(call=>call.method==="recordSubmitted")).toBe(true);
    expect(calls.some(call=>call.method==="recordUnknown")).toBe(false);
  });

  it("quarantines ambiguous provider outcomes instead of retrying a possible transfer",async()=>{
    const {worker,calls}=makeWorker({providerThrows:true});
    await expect(worker.runOnce()).resolves.toEqual({outcome:"reconciliation_required",outboxId:"outbox-1"});
    expect(calls.some(call=>call.method==="recordUnknown")).toBe(true);
    expect(calls.some(call=>call.method==="recordRetry")).toBe(false);
  });

  it("retries vault failures before contacting the provider",async()=>{
    const {worker,calls,submit}=makeWorker({vaultThrows:true});
    await expect(worker.runOnce()).resolves.toEqual({outcome:"retry_scheduled",outboxId:"outbox-1"});
    expect(submit).not.toHaveBeenCalled();
    expect(calls.some(call=>call.method==="recordRetry")).toBe(true);
  });

  it("records explicit provider rejection as failed",async()=>{
    const {worker,calls}=makeWorker({providerResult:{status:"rejected",code:"DESTINATION_REJECTED"}});
    await expect(worker.runOnce()).resolves.toEqual({outcome:"failed",outboxId:"outbox-1"});
    expect(calls.some(call=>call.method==="recordRejected")).toBe(true);
  });

  it("uses provider-declared safe retry outcomes only",async()=>{
    const {worker,calls}=makeWorker({providerResult:{status:"retry_safe",code:"RATE_LIMITED",delaySeconds:30}});
    await expect(worker.runOnce()).resolves.toEqual({outcome:"retry_scheduled",outboxId:"outbox-1"});
    expect(calls.some(call=>call.method==="recordRetry")).toBe(true);
    expect(calls.some(call=>call.method==="recordUnknown")).toBe(false);
  });
});
