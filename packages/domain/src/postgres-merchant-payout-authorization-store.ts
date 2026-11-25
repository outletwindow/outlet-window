import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

export type MerchantPayoutRequesterRole = "operations" | "finance" | "platform_admin" | "platform_owner";
export type MerchantPayoutReviewerRole = "finance" | "platform_admin" | "platform_owner";
export type MerchantPayoutDecision = "authorize" | "reject";

export interface MerchantPayoutIntent {
  id: string;
  tenantId: string;
  merchantId: string;
  currency: string;
  settlementBatchId: string;
  amountMinor: number;
  idempotencyKey: string;
  status: "pending_approval" | "authorized" | "rejected";
  requestedBy: string;
  requesterRole: MerchantPayoutRequesterRole;
  requestedAtUtc: string;
  reviewedBy: string | null;
  reviewerRole: MerchantPayoutReviewerRole | null;
  reviewedAtUtc: string | null;
  reviewNote: string | null;
}
type PayoutRow = {
  id: string; tenant_id: string; merchant_id: string; currency: string;
  settlement_batch_id: string; amount_minor: string | number; idempotency_key: string;
  status: MerchantPayoutIntent["status"]; requested_by: string;
  requester_role: MerchantPayoutRequesterRole; requested_at: Date | string;
  reviewed_by: string | null; reviewer_role: MerchantPayoutReviewerRole | null;
  reviewed_at: Date | string | null; review_note: string | null;
};
export type MerchantPayoutRequestOutcome =
  | { outcome: "created"; intent: MerchantPayoutIntent }
  | { outcome: "not_found" | "already_active" | "invalid_batch" };
export type MerchantPayoutDecisionOutcome =
  | { outcome: "decided"; intent: MerchantPayoutIntent }
  | { outcome: "not_found" | "already_decided" | "self_approval" | "invalid_transition" };

function mapRow(row: PayoutRow): MerchantPayoutIntent {
  const amountMinor = Number(row.amount_minor);
  const requestedAtUtc = new Date(row.requested_at).toISOString();
  const reviewedAtUtc = row.reviewed_at === null ? null : new Date(row.reviewed_at).toISOString();
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
      !Number.isFinite(Date.parse(requestedAtUtc)) ||
      (reviewedAtUtc !== null && !Number.isFinite(Date.parse(reviewedAtUtc)))) {
    throw new Error("invalid_merchant_payout_intent_row");
  }
  return {
    id: row.id, tenantId: row.tenant_id, merchantId: row.merchant_id, currency: row.currency,
    settlementBatchId: row.settlement_batch_id, amountMinor, idempotencyKey: row.idempotency_key,
    status: row.status, requestedBy: row.requested_by, requesterRole: row.requester_role,
    requestedAtUtc, reviewedBy: row.reviewed_by, reviewerRole: row.reviewer_role,
    reviewedAtUtc, reviewNote: row.review_note
  };
}
function state(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code) : undefined;
}
const columns = `id,tenant_id,merchant_id,currency,settlement_batch_id,amount_minor,
  idempotency_key,status,requested_by,requester_role,requested_at,reviewed_by,
  reviewer_role,reviewed_at,review_note`;

export class PostgresMerchantPayoutAuthorizationStore {
  constructor(private readonly pool: PostgresPool) {}

  async request(input: {
    settlementBatchId: string; amountMinor: number; idempotencyKey: string;
    requesterId: string; requesterRole: MerchantPayoutRequesterRole;
  }): Promise<MerchantPayoutRequestOutcome> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 ||
        input.idempotencyKey.trim().length < 8 || !input.requesterId.trim()) {
      throw new Error("merchant_payout_request_input_invalid");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{ tenant_id: string; merchant_id: string; currency: string }>(
        "SELECT tenant_id,merchant_id,currency FROM merchant_settlement_batches WHERE id=$1 FOR UPDATE",
        [input.settlementBatchId]
      );
      if (!batch.rows[0]) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      const row = await client.query<PayoutRow>(
        `INSERT INTO merchant_payout_intents
          (id,tenant_id,merchant_id,currency,settlement_batch_id,amount_minor,
           idempotency_key,requested_by,requester_role)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING ${columns}`,
        [randomUUID(),batch.rows[0].tenant_id,batch.rows[0].merchant_id,batch.rows[0].currency,
          input.settlementBatchId,input.amountMinor,input.idempotencyKey,input.requesterId,input.requesterRole]
      );
      await client.query("COMMIT");
      if (!row.rows[0]) throw new Error("merchant_payout_request_insert_returned_no_row");
      return { outcome: "created", intent: mapRow(row.rows[0]) };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      if (state(error) === "23505") return { outcome: "already_active" };
      if (state(error) === "23514") return { outcome: "invalid_batch" };
      throw error;
    } finally { client.release(); }
  }

  async listPending(input: { limit?: number } = {}): Promise<MerchantPayoutIntent[]> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("merchant_payout_limit_invalid");
    const result = await this.pool.query<PayoutRow>(
      `SELECT ${columns} FROM merchant_payout_intents
       WHERE status='pending_approval' ORDER BY requested_at ASC,id ASC LIMIT $1`, [limit]
    );
    return result.rows.map(mapRow);
  }

  async decide(input: {
    payoutIntentId: string; actorId: string; actorRole: MerchantPayoutReviewerRole;
    decision: MerchantPayoutDecision; reason?: string;
  }): Promise<MerchantPayoutDecisionOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const intent = await client.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM merchant_payout_intents WHERE id=$1 FOR UPDATE",
        [input.payoutIntentId]
      );
      if (!intent.rows[0]) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      await client.query(
        `INSERT INTO merchant_payout_decisions
          (id,tenant_id,payout_intent_id,decision,actor_id,actor_role,reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(),intent.rows[0].tenant_id,input.payoutIntentId,input.decision,
          input.actorId,input.actorRole,input.reason ?? null]
      );
      const result = await client.query<PayoutRow>(
        `SELECT ${columns} FROM merchant_payout_intents WHERE tenant_id=$1 AND id=$2`,
        [intent.rows[0].tenant_id,input.payoutIntentId]
      );
      if (!result.rows[0]) throw new Error("merchant_payout_intent_missing_after_decision");
      await client.query("COMMIT");
      return { outcome: "decided", intent: mapRow(result.rows[0]) };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      if (state(error) === "42501") return { outcome: "self_approval" };
      if (state(error) === "23505") return { outcome: "already_decided" };
      if (state(error) === "23514") return { outcome: "invalid_transition" };
      throw error;
    } finally { client.release(); }
  }
}
