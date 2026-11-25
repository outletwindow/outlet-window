import type { PostgresPool } from "./postgres-iam-store.js";

export type SettlementAccountingActorRole = "finance" | "platform_admin" | "platform_owner";
export type SettlementAccountingPostingOutcome =
  | { outcome: "posted"; journalId: string }
  | { outcome: "not_found" }
  | { outcome: "not_authorized" }
  | { outcome: "not_ready"; reason: string };

/**
 * Executes the database's atomic settlement posting function inside one
 * caller-owned transaction. Actor identity must come from a verified API session.
 */
export class PostgresMerchantSettlementAccountingPoster {
  constructor(private readonly pool: PostgresPool) {}

  async post(input: {
    batchId: string;
    actorId: string;
    actorRole: SettlementAccountingActorRole;
  }): Promise<SettlementAccountingPostingOutcome> {
    if (!input.batchId.trim() || !input.actorId.trim()) {
      throw new Error("settlement_accounting_input_invalid");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM merchant_settlement_batches WHERE id=$1 FOR UPDATE",
        [input.batchId]
      );
      if (!batch.rows[0]) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      const result = await client.query<{ journal_id: string }>(
        "SELECT post_merchant_settlement_accounting($1,$2,$3,$4) AS journal_id",
        [batch.rows[0].tenant_id, input.batchId, input.actorId, input.actorRole]
      );
      const journalId = result.rows[0]?.journal_id;
      if (!journalId) throw new Error("settlement_accounting_journal_result_missing");
      await client.query("COMMIT");
      return { outcome: "posted", journalId };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
      const code = error instanceof Error ? error.message : "";
      if (code.includes("settlement_accounting_authorization_required") ||
          code.includes("settlement_requester_cannot_post_own_batch") ||
          code.includes("settlement_accounting_actor_not_authorized")) {
        return { outcome: "not_authorized" };
      }
      if (code.includes("settlement_batch_not_found")) return { outcome: "not_found" };
      const safeReasons = [
        "settlement_batch_not_postable",
        "settlement_policy_snapshot_required",
        "settlement_policy_snapshot_not_approved",
        "settlement_batch_totals_invalid",
        "settlement_approval_snapshot_changed",
        "settlement_line_contract_policy_mismatch",
        "settlement_deduction_account_mapping_missing_or_inactive",
        "settlement_required_control_accounts_missing",
        "settlement_journal_idempotency_collision"
      ];
      const reason = safeReasons.find(item => code.includes(item));
      if (reason) return { outcome: "not_ready", reason };
      throw error;
    } finally {
      client.release();
    }
  }
}
