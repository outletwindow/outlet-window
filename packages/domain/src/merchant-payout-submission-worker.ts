import type { PostgresMerchantPayoutProviderOutbox } from "./postgres-merchant-payout-provider-outbox.js";

export interface MerchantPayoutDestinationCredential {
  /** Provider-scoped token/reference resolved from the secret vault, never logged. */
  destinationToken: string;
}
export interface MerchantPayoutDestinationVault {
  resolve(input: { tenantId: string; merchantId: string; providerKey: string; vaultReference: string }):
    Promise<MerchantPayoutDestinationCredential>;
}
export type MerchantPayoutProviderResult =
  | { status: "accepted"; providerReference: string }
  | { status: "rejected"; code: string }
  | { status: "retry_safe"; code: string; delaySeconds?: number }
  | { status: "unknown"; code: string };
export interface MerchantPayoutProvider {
  submit(input: {
    payoutId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    destinationToken: string;
  }): Promise<MerchantPayoutProviderResult>;
}
export interface MerchantPayoutProviderRegistry {
  get(providerKey: string): MerchantPayoutProvider | undefined;
}
export type MerchantPayoutWorkerResult =
  | { outcome: "idle" }
  | { outcome: "submitted" | "failed" | "retry_scheduled" | "reconciliation_required" | "lease_lost"; outboxId: string };

/**
 * Dispatches one authorized payout. Provider acceptance is only "submitted";
 * a separately verified provider event is required to confirm that money moved.
 */
export class MerchantPayoutSubmissionWorker {
  constructor(
    private readonly store: PostgresMerchantPayoutProviderOutbox,
    private readonly vault: MerchantPayoutDestinationVault,
    private readonly providers: MerchantPayoutProviderRegistry,
    private readonly workerId: string,
    private readonly providerKey: string,
    private readonly leaseSeconds = 45
  ) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(workerId) ||
        !/^[a-zA-Z0-9._-]{1,100}$/.test(providerKey) ||
        !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 300) {
      throw new Error("INVALID_MERCHANT_PAYOUT_WORKER_CONFIGURATION");
    }
  }

  async runOnce(): Promise<MerchantPayoutWorkerResult> {
    const job = await this.store.claimNext(this.workerId,this.providerKey,this.leaseSeconds);
    if (!job) return { outcome: "idle" };
    const provider = this.providers.get(job.providerKey);
    if (!provider) {
      const result = await this.store.recordRetry({
        outboxId: job.outboxId,workerId: this.workerId,
        failureCode: "PAYOUT_PROVIDER_NOT_CONFIGURED",delaySeconds: 300
      });
      return { outcome: result === "rescheduled" ? "retry_scheduled" :
        result === "dead_lettered" ? "failed" : "lease_lost",outboxId: job.outboxId };
    }

    let credential: MerchantPayoutDestinationCredential;
    try {
      credential = await this.vault.resolve({
        tenantId: job.tenantId,merchantId: job.merchantId,
        providerKey: job.providerKey,vaultReference: job.vaultReference
      });
      if (!credential.destinationToken.trim()) throw new Error("PAYOUT_DESTINATION_CREDENTIAL_EMPTY");
    } catch {
      const delaySeconds = Math.min(3600,5 * 2 ** Math.min(job.attemptCount - 1,9));
      const result = await this.store.recordRetry({
        outboxId: job.outboxId,workerId: this.workerId,
        failureCode: "PAYOUT_DESTINATION_VAULT_UNAVAILABLE",delaySeconds
      });
      return { outcome: result === "rescheduled" ? "retry_scheduled" :
        result === "dead_lettered" ? "failed" : "lease_lost",outboxId: job.outboxId };
    }

    let result: MerchantPayoutProviderResult;
    try {
      result = await provider.submit({
        payoutId: job.payoutIntentId,amountMinor: job.amountMinor,
        currency: job.currency,idempotencyKey: job.idempotencyKey,
        destinationToken: credential.destinationToken
      });
    } catch {
      // Once submit was invoked, a thrown network/client error is ambiguous.
      // Never blindly retry a payout that might already have been accepted.
      const outcome = await this.store.recordUnknown({
        outboxId: job.outboxId,workerId: this.workerId,
        failureCode: "PAYOUT_PROVIDER_OUTCOME_UNKNOWN"
      });
      return { outcome, outboxId: job.outboxId };
    }

    if (result.status === "accepted") {
      if (!result.providerReference.trim() || result.providerReference.length > 240) {
        const outcome = await this.store.recordUnknown({
          outboxId: job.outboxId,workerId: this.workerId,
          failureCode: "PAYOUT_PROVIDER_REFERENCE_INVALID"
        });
        return { outcome,outboxId: job.outboxId };
      }
      const outcome = await this.store.recordSubmitted({
        outboxId: job.outboxId,workerId: this.workerId,
        providerReference: result.providerReference
      });
      return { outcome,outboxId: job.outboxId };
    }
    if (result.status === "unknown") {
      const outcome = await this.store.recordUnknown({
        outboxId: job.outboxId,workerId: this.workerId,failureCode: result.code
      });
      return { outcome,outboxId: job.outboxId };
    }
    if (result.status === "rejected") {
      const outcome = await this.store.recordRejected({
        outboxId: job.outboxId,workerId: this.workerId,failureCode: result.code
      });
      return { outcome,outboxId: job.outboxId };
    }
    const delaySeconds = result.delaySeconds ?? Math.min(3600,5 * 2 ** Math.min(job.attemptCount - 1,9));
    const outcome = await this.store.recordRetry({
      outboxId: job.outboxId,workerId: this.workerId,
      failureCode: result.code,delaySeconds
    });
    return { outcome: outcome === "rescheduled" ? "retry_scheduled" :
      outcome === "dead_lettered" ? "failed" : "lease_lost",outboxId: job.outboxId };
  }
}
