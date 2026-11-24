import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

export type SettlementApprovalRole = "operations" | "finance" | "platform_admin" | "platform_owner";
export type SettlementApprovalDecision = "authorize_accounting" | "reject";
export interface SettlementApprovalRequest {
  id: string; tenantId: string; batchId: string; merchantId: string; currency: string;
  requestedBy: string; requesterRole: SettlementApprovalRole; status: "pending" | "authorized_for_accounting" | "rejected";
  snapshotLineCount: number; snapshotGrossMinor: number; snapshotDeductionsMinor: number; snapshotNetMinor: number;
  requestedAtUtc: string; reviewedBy: string | null; reviewerRole: string | null; reviewedAtUtc: string | null; reviewNote: string | null;
}
export type SettlementApprovalOutcome =
  | { outcome: "created"; request: SettlementApprovalRequest }
  | { outcome: "not_found" | "already_pending" | "invalid_batch_state" | "empty_or_unbalanced_batch" };
export type SettlementDecisionOutcome =
  | { outcome: "decided"; request: SettlementApprovalRequest }
  | { outcome: "not_found" | "already_decided" | "self_approval" | "snapshot_changed" | "invalid_transition" };

type ApprovalRow = {
  id: string; tenant_id: string; batch_id: string; merchant_id: string; currency: string;
  requested_by: string; requester_role: SettlementApprovalRole;
  status: SettlementApprovalRequest["status"]; snapshot_line_count: string | number;
  snapshot_gross_minor: string | number; snapshot_deductions_minor: string | number;
  snapshot_net_minor: string | number; requested_at: Date | string;
  reviewed_by: string | null; reviewer_role: string | null; reviewed_at: Date | string | null;
  review_note: string | null;
};
function safeInteger(value: string | number, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`invalid_settlement_approval_${field}`);
  return result;
}
function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_settlement_approval_timestamp");
  return date.toISOString();
}
function mapRow(row: ApprovalRow): SettlementApprovalRequest {
  const requestedAtUtc = timestamp(row.requested_at);
  if (!requestedAtUtc) throw new Error("invalid_settlement_approval_requested_at");
  return {
    id: row.id, tenantId: row.tenant_id, batchId: row.batch_id, merchantId: row.merchant_id,
    currency: row.currency, requestedBy: row.requested_by, requesterRole: row.requester_role,
    status: row.status, snapshotLineCount: safeInteger(row.snapshot_line_count, "line_count"),
    snapshotGrossMinor: safeInteger(row.snapshot_gross_minor, "gross"),
    snapshotDeductionsMinor: safeInteger(row.snapshot_deductions_minor, "deductions"),
    snapshotNetMinor: safeInteger(row.snapshot_net_minor, "net"),
    requestedAtUtc, reviewedBy: row.reviewed_by, reviewerRole: row.reviewer_role,
    reviewedAtUtc: timestamp(row.reviewed_at), reviewNote: row.review_note
  };
}
function sqlState(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code) : undefined;
}

/** Transactional persistence for the database-enforced dual-control approval workflow. */
export class PostgresMerchantSettlementApprovalStore {
  constructor(private readonly pool: PostgresPool) {}

  async request(input: {
    batchId: string; requesterId: string; requesterRole: SettlementApprovalRole;
  }): Promise<SettlementApprovalOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{ status: string }>(
        "SELECT status FROM merchant_settlement_batches WHERE id=$1 FOR UPDATE", [input.batchId]
      );
      if (!batch.rows[0]) { await client.query("ROLLBACK"); return { outcome: "not_found" }; }
      if (batch.rows[0].status !== "draft") { await client.query("ROLLBACK"); return { outcome: "invalid_batch_state" }; }
      const id = randomUUID();
      const inserted = await client.query<ApprovalRow>(
        `INSERT INTO merchant_settlement_approval_requests
          (id,tenant_id,batch_id,merchant_id,currency,requested_by,requester_role)
         SELECT $1,tenant_id,id,merchant_id,currency,$2,$3
         FROM merchant_settlement_batches WHERE id=$4
         RETURNING id,tenant_id,batch_id,merchant_id,currency,requested_by,requester_role,status,
           snapshot_line_count,snapshot_gross_minor,snapshot_deductions_minor,snapshot_net_minor,
           requested_at,reviewed_by,reviewer_role,reviewed_at,review_note`,
        [id,input.requesterId,input.requesterRole,input.batchId]
      );
      if (!inserted.rows[0]) throw new Error("settlement_approval_insert_returned_no_row");
      await client.query("COMMIT");
      return { outcome: "created", request: mapRow(inserted.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      if (sqlState(error) === "23505") return { outcome: "already_pending" };
      if (sqlState(error) === "23514") return { outcome: "empty_or_unbalanced_batch" };
      throw error;
    } finally { client.release(); }
  }

  async decide(input: {
    requestId: string; actorId: string; actorRole: "finance" | "platform_admin" | "platform_owner";
    decision: SettlementApprovalDecision; reason?: string;
  }): Promise<SettlementDecisionOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const request = await client.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM merchant_settlement_approval_requests WHERE id=$1 FOR UPDATE",
        [input.requestId]
      );
      if (!request.rows[0]) { await client.query("ROLLBACK"); return { outcome: "not_found" }; }
      const inserted = await client.query(
        `INSERT INTO merchant_settlement_approval_decisions
          (id,tenant_id,request_id,decision,actor_id,actor_role,reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(),request.rows[0].tenant_id,input.requestId,input.decision,input.actorId,input.actorRole,input.reason ?? null]
      );
      void inserted;
      const updated = await client.query<ApprovalRow>(
        `SELECT id,tenant_id,batch_id,merchant_id,currency,requested_by,requester_role,status,
          snapshot_line_count,snapshot_gross_minor,snapshot_deductions_minor,snapshot_net_minor,
          requested_at,reviewed_by,reviewer_role,reviewed_at,review_note
         FROM merchant_settlement_approval_requests WHERE tenant_id=$1 AND id=$2`,
        [request.rows[0].tenant_id,input.requestId]
      );
      if (!updated.rows[0]) throw new Error("settlement_approval_disappeared_after_decision");
      await client.query("COMMIT");
      return { outcome: "decided", request: mapRow(updated.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      const state = sqlState(error);
      if (state === "42501") return { outcome: "self_approval" };
      if (state === "23505") return { outcome: "already_decided" };
      if (state === "23514") {
        const message = error instanceof Error ? error.message : "";
        return { outcome: message.includes("snapshot_changed") ? "snapshot_changed" : "invalid_transition" };
      }
      throw error;
    } finally { client.release(); }
  }
}
