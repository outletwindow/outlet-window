import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

export interface MerchantPayoutProviderEntity {
  id: string;
  tenantId: string;
  merchantId: string;
  providerKey: string;
  providerMerchantId: string;
  providerEntityId: string;
  status: "active" | "revoked";
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
}

type DbRow = {
  id: string; tenant_id: string; merchant_id: string; provider_key: string;
  provider_merchant_id: string; provider_entity_id: string; status: "active" | "revoked";
  created_by: string; created_at: Date | string; revoked_at: Date | string | null;
};

function mapRow(row: DbRow): MerchantPayoutProviderEntity {
  return {
    id: row.id, tenantId: row.tenant_id, merchantId: row.merchant_id,
    providerKey: row.provider_key, providerMerchantId: row.provider_merchant_id,
    providerEntityId: row.provider_entity_id, status: row.status, createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString()
  };
}

/** Platform-only registry. Provider identifiers are immutable; revocation is terminal. */
export class PostgresMerchantPayoutProviderEntityRegistry {
  constructor(private readonly pool: PostgresPool) {}

  async register(input: {
    tenantId: string; merchantId: string; providerKey: string;
    providerMerchantId: string; providerEntityId: string; actorId: string;
  }): Promise<{ outcome: "created"; entity: MerchantPayoutProviderEntity } |
    { outcome: "merchant_not_found" | "identity_conflict" }> {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.tenantId) ||
        !/^[A-Za-z0-9._:-]{1,160}$/.test(input.merchantId) ||
        input.providerKey !== "moyasar" ||
        !/^[A-Za-z0-9._:-]{1,240}$/.test(input.providerMerchantId) ||
        !/^[A-Za-z0-9._:-]{1,240}$/.test(input.providerEntityId) ||
        !/^[A-Za-z0-9._:-]{1,160}$/.test(input.actorId)) {
      throw new Error("INVALID_MERCHANT_PAYOUT_PROVIDER_ENTITY");
    }
    try {
      const result = await this.pool.query<DbRow>(
        `INSERT INTO merchant_payout_provider_entities
          (id,tenant_id,merchant_id,provider_key,provider_merchant_id,provider_entity_id,created_by)
         SELECT $1,m.tenant_id,m.id,$4,$5,$6,$7
         FROM merchants m
         WHERE m.tenant_id=$2 AND m.id=$3 AND m.status='active'
         RETURNING id,tenant_id,merchant_id,provider_key,provider_merchant_id,
                   provider_entity_id,status,created_by,created_at,revoked_at`,
        [randomUUID(), input.tenantId, input.merchantId, input.providerKey,
          input.providerMerchantId, input.providerEntityId, input.actorId]
      );
      if (result.rowCount !== 1 || !result.rows[0]) return { outcome: "merchant_not_found" };
      return { outcome: "created", entity: mapRow(result.rows[0]) };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code) : "";
      if (code === "23505") return { outcome: "identity_conflict" };
      throw error;
    }
  }

  async revoke(input: { entityId: string; actorId: string }): Promise<
    { outcome: "revoked" } | { outcome: "not_found" | "already_revoked" }
  > {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.entityId) ||
        !/^[A-Za-z0-9._:-]{1,160}$/.test(input.actorId)) {
      throw new Error("INVALID_MERCHANT_PAYOUT_PROVIDER_ENTITY_REVOCATION");
    }
    const result = await this.pool.query<{ id: string }>(
      `UPDATE merchant_payout_provider_entities
       SET status='revoked',revoked_at=now()
       WHERE id=$1 AND status='active'
       RETURNING id`,
      [input.entityId]
    );
    if (result.rowCount === 1) return { outcome: "revoked" };
    const existing = await this.pool.query<{ status: string }>(
      "SELECT status FROM merchant_payout_provider_entities WHERE id=$1",
      [input.entityId]
    );
    if (existing.rowCount === 0) return { outcome: "not_found" };
    return { outcome: "already_revoked" };
  }

  async list(input: { tenantId?: string; limit?: number } = {}): Promise<MerchantPayoutProviderEntity[]> {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
        (input.tenantId !== undefined && !/^[A-Za-z0-9._:-]{1,160}$/.test(input.tenantId))) {
      throw new Error("INVALID_MERCHANT_PAYOUT_PROVIDER_ENTITY_QUERY");
    }
    const result = await this.pool.query<DbRow>(
      `SELECT id,tenant_id,merchant_id,provider_key,provider_merchant_id,provider_entity_id,
              status,created_by,created_at,revoked_at
       FROM merchant_payout_provider_entities
       WHERE ($1::text IS NULL OR tenant_id=$1)
       ORDER BY created_at DESC,id DESC LIMIT $2`,
      [input.tenantId ?? null, limit]
    );
    return result.rows.map(mapRow);
  }
}
