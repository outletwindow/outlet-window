import type { PostgresMerchantPayoutProviderOutbox } from "./postgres-merchant-payout-provider-outbox.js";

export type MerchantPayoutDestinationDetails =
  | { type: "bank"; iban: string; name: string; mobile: string; country: string; city: string }
  | { type: "wallet"; mobile: string };

export interface MerchantPayoutDestinationCredential {
  /** Provider-scoped token/reference resolved from the vault, never logged. */
  destinationToken?: string;
  /** Transient beneficiary details for providers such as Moyasar; never persist or log. */
  destination?: MerchantPayoutDestinationDetails;
}
export interface MerchantPayoutDestinationVault {
  resolve(input: { tenantId: string; merchantId: string; providerKey: string; vaultReference: string }): Promise<MerchantPayoutDestinationCredential>;
}
export type MerchantPayoutProviderResult =
  | { status: "accepted"; providerReference: string }
  | { status: "rejected"; code: string }
  | { status: "retry_safe"; code: string; delaySeconds?: number }
  | { status: "unknown"; code: string };
export interface MerchantPayoutProvider {
  submit(input: { payoutId: string; outboxId: string; amountMinor: number; currency: string; idempotencyKey: string; destinationToken?: string; destination?: MerchantPayoutDestinationDetails }): Promise<MerchantPayoutProviderResult>;
}
export interface MerchantPayoutProviderRegistry {
  get(providerKey: string): MerchantPayoutProvider | undefined;
}
export type MerchantPayoutWorkerResult =
  | { outcome: "idle" }
  | { outcome: "submitted" | "failed" | "retry_scheduled" | "reconciliation_required" | "lease_lost"; outboxId: string };

/** Provider acceptance is only submitted; a separately verified event confirms movement. */
export class MerchantPayoutSubmissionWorker {
  constructor(
    private readonly store: PostgresMerchantPayoutProviderOutbox,
    private readonly vault: MerchantPayoutDestinationVault,
    private readonly providers: MerchantPayoutProviderRegistry,
    private readonly workerId: string,
    private readonly providerKey: string,
    private readonly leaseSeconds = 45
  ) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(workerId) || !/^[a-zA-Z0-9._-]{1,100}$/.test(providerKey) ||
        !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 300) {
      throw new Error("INVALID_MERCHANT_PAYOUT_WORKER_CONFIGURATION");
    }
  }

  async runOnce(): Promise<MerchantPayoutWorkerResult> {
    const job = await this.store.claimNext(this.workerId,this.providerKey,this.leaseSeconds);
    if (!job) return { outcome: "idle" };
    const provider = this.providers.get(job.providerKey);
    if (!provider) {
      const result = await this.store.recordRetry({outboxId:job.outboxId,workerId:this.workerId,failureCode:"PAYOUT_PROVIDER_NOT_CONFIGURED",delaySeconds:300});
      return {outcome:result==="rescheduled"?"retry_scheduled":result==="dead_lettered"?"failed":"lease_lost",outboxId:job.outboxId};
    }

    let credential: MerchantPayoutDestinationCredential;
    try {
      credential = await this.vault.resolve({tenantId:job.tenantId,merchantId:job.merchantId,providerKey:job.providerKey,vaultReference:job.vaultReference});
      if ((!credential.destinationToken || !credential.destinationToken.trim()) && !credential.destination) {
        throw new Error("PAYOUT_DESTINATION_CREDENTIAL_EMPTY");
      }
    } catch {
      const delaySeconds=Math.min(3600,5*2**Math.min(job.attemptCount-1,9));
      const result=await this.store.recordRetry({outboxId:job.outboxId,workerId:this.workerId,failureCode:"PAYOUT_DESTINATION_VAULT_UNAVAILABLE",delaySeconds});
      return {outcome:result==="rescheduled"?"retry_scheduled":result==="dead_lettered"?"failed":"lease_lost",outboxId:job.outboxId};
    }

    let result: MerchantPayoutProviderResult;
    try {
      result=await provider.submit({
        payoutId:job.payoutIntentId,outboxId:job.outboxId,amountMinor:job.amountMinor,
        currency:job.currency,idempotencyKey:job.idempotencyKey,
        ...(credential.destinationToken === undefined ? {} : {destinationToken:credential.destinationToken}),
        ...(credential.destination === undefined ? {} : {destination:credential.destination})
      });
    } catch {
      const outcome=await this.store.recordUnknown({outboxId:job.outboxId,workerId:this.workerId,failureCode:"PAYOUT_PROVIDER_OUTCOME_UNKNOWN"});
      return {outcome,outboxId:job.outboxId};
    }

    if (result.status==="accepted") {
      if (!result.providerReference.trim() || result.providerReference.length>240) {
        const outcome=await this.store.recordUnknown({outboxId:job.outboxId,workerId:this.workerId,failureCode:"PAYOUT_PROVIDER_REFERENCE_INVALID"});
        return {outcome,outboxId:job.outboxId};
      }
      const outcome=await this.store.recordSubmitted({outboxId:job.outboxId,workerId:this.workerId,providerReference:result.providerReference});
      // A conflicting/stale lease is not success; expose it as lease_lost.
      return {outcome:outcome==="submitted"?"submitted":"lease_lost",outboxId:job.outboxId};
    }
    if (result.status==="unknown") {
      const outcome=await this.store.recordUnknown({outboxId:job.outboxId,workerId:this.workerId,failureCode:result.code});
      return {outcome,outboxId:job.outboxId};
    }
    if (result.status==="rejected") {
      const outcome=await this.store.recordRejected({outboxId:job.outboxId,workerId:this.workerId,failureCode:result.code});
      return {outcome,outboxId:job.outboxId};
    }
    const delaySeconds=result.delaySeconds??Math.min(3600,5*2**Math.min(job.attemptCount-1,9));
    const outcome=await this.store.recordRetry({outboxId:job.outboxId,workerId:this.workerId,failureCode:result.code,delaySeconds});
    return {outcome:outcome==="rescheduled"?"retry_scheduled":outcome==="dead_lettered"?"failed":"lease_lost",outboxId:job.outboxId};
  }
}
