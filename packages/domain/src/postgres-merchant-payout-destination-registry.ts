import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres-iam-store.js";

export interface MerchantPayoutDestinationSummary {
  id: string;
  tenantId: string;
  merchantId: string;
  providerKey: string;
  currency: string;
  providerEntityRegistryId: string;
  verificationStatus: "pending" | "verified" | "revoked";
  createdBy: string;
  createdAt: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

/** Safe destination administration. The opaque vault reference is never returned. */
export class PostgresMerchantPayoutDestinationRegistry {
  constructor(private readonly pool: PostgresPool) {}

  async register(input: {
    tenantId: string; merchantId: string; providerKey: string; currency: string;
    providerEntityRegistryId: string; vaultReference: string; actorId: string;
  }): Promise<{ outcome: "created"; destination: MerchantPayoutDestinationSummary } |
    { outcome: "provider_entity_not_found" | "duplicate" }> {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.tenantId) ||
        !/^[A-Za-z0-9._:-]{1,160}$/.test(input.merchantId) ||
        input.providerKey !== "moyasar" ||
        !/^[A-Z]{3}$/.test(input.currency) ||
        !/^[A-Za-z0-9._:-]{1,160}$/.test(input.providerEntityRegistryId) ||
        !/^[A-Za-z0-9._:-]{1,160}$/.test(input.actorId) ||
        typeof input.vaultReference !== "string" || input.vaultReference.trim().length < 8 ||
        input.vaultReference.trim().length > 500) {
      throw new Error("INVALID_MERCHANT_PAYOUT_DESTINATION");
    }
    try {
      const result = await this.pool.query<{
        id:string;tenant_id:string;merchant_id:string;provider_key:string;currency:string;
        provider_entity_registry_id:string;verification_status:"pending"|"verified"|"revoked";
        created_by:string;created_at:Date|string;verified_by:string|null;verified_at:Date|string|null;
      }>(`INSERT INTO merchant_payout_destinations
        (id,tenant_id,merchant_id,provider_key,currency,vault_reference,
         verification_status,provider_entity_registry_id,created_by)
       SELECT $1,e.tenant_id,e.merchant_id,e.provider_key,$5,$6,'pending',e.id,$7
       FROM merchant_payout_provider_entities e
       WHERE e.tenant_id=$2 AND e.merchant_id=$3 AND e.provider_key=$4
         AND e.id=$8 AND e.status='active'
       RETURNING id,tenant_id,merchant_id,provider_key,currency,
         provider_entity_registry_id,verification_status,created_by,created_at,verified_by,verified_at`,
       [randomUUID(),input.tenantId,input.merchantId,input.providerKey,input.currency,
        input.vaultReference.trim(),input.actorId,input.providerEntityRegistryId]);
      const row=result.rows[0];
      if (!row) return {outcome:"provider_entity_not_found"};
      return {outcome:"created",destination:{
        id:row.id,tenantId:row.tenant_id,merchantId:row.merchant_id,providerKey:row.provider_key,
        currency:row.currency,providerEntityRegistryId:row.provider_entity_registry_id,
        verificationStatus:row.verification_status,createdBy:row.created_by,
        createdAt:new Date(row.created_at).toISOString(),verifiedBy:row.verified_by,
        verifiedAt:row.verified_at===null?null:new Date(row.verified_at).toISOString()
      }};
    } catch(error) {
      const code=error&&typeof error==="object"&&"code" in error?String((error as {code:unknown}).code):"";
      if(code==="23505") return {outcome:"duplicate"};
      throw error;
    }
  }

  async list(input:{tenantId?:string;merchantId?:string;limit?:number}={}):Promise<MerchantPayoutDestinationSummary[]> {
    const limit=input.limit??100;
    if(!Number.isSafeInteger(limit)||limit<1||limit>200) throw new Error("INVALID_MERCHANT_PAYOUT_DESTINATION_QUERY");
    const result=await this.pool.query<{
      id:string;tenant_id:string;merchant_id:string;provider_key:string;currency:string;
      provider_entity_registry_id:string;verification_status:"pending"|"verified"|"revoked";
      created_by:string|null;created_at:Date|string;verified_by:string|null;verified_at:Date|string|null;
    }>(`SELECT id,tenant_id,merchant_id,provider_key,currency,provider_entity_registry_id,
       verification_status,created_by,created_at,verified_by,verified_at
       FROM merchant_payout_destinations
       WHERE ($1::text IS NULL OR tenant_id=$1)
         AND ($2::text IS NULL OR merchant_id=$2)
       ORDER BY created_at DESC,id DESC LIMIT $3`,
      [input.tenantId??null,input.merchantId??null,limit]);
    return result.rows.map(row=>({
      id:row.id,tenantId:row.tenant_id,merchantId:row.merchant_id,providerKey:row.provider_key,
      currency:row.currency,providerEntityRegistryId:row.provider_entity_registry_id,
      verificationStatus:row.verification_status,createdBy:row.created_by??"",
      createdAt:new Date(row.created_at).toISOString(),verifiedBy:row.verified_by,
      verifiedAt:row.verified_at===null?null:new Date(row.verified_at).toISOString()
    }));
  }

  async verify(input:{destinationId:string;actorId:string}):Promise<
    {outcome:"verified";destination:MerchantPayoutDestinationSummary}|
    {outcome:"not_found"|"self_approval"|"not_pending"|"provider_entity_inactive"}> {
    const result=await this.pool.query<{
      id:string;tenant_id:string;merchant_id:string;provider_key:string;currency:string;
      provider_entity_registry_id:string;verification_status:"pending"|"verified"|"revoked";
      created_by:string;created_at:Date|string;verified_by:string;verified_at:Date|string;
    }>(`UPDATE merchant_payout_destinations d
      SET verification_status='verified',verified_by=$2,verified_at=now(),updated_at=now()
      WHERE d.id=$1 AND d.verification_status='pending' AND d.created_by<>$2
        AND EXISTS (SELECT 1 FROM merchant_payout_provider_entities e
          WHERE e.id=d.provider_entity_registry_id AND e.tenant_id=d.tenant_id
            AND e.merchant_id=d.merchant_id AND e.provider_key=d.provider_key AND e.status='active')
      RETURNING d.id,d.tenant_id,d.merchant_id,d.provider_key,d.currency,
        d.provider_entity_registry_id,d.verification_status,d.created_by,d.created_at,d.verified_by,d.verified_at`,
      [input.destinationId,input.actorId]);
    const row=result.rows[0];
    if(row) return {outcome:"verified",destination:{
      id:row.id,tenantId:row.tenant_id,merchantId:row.merchant_id,providerKey:row.provider_key,
      currency:row.currency,providerEntityRegistryId:row.provider_entity_registry_id,
      verificationStatus:row.verification_status,createdBy:row.created_by,
      createdAt:new Date(row.created_at).toISOString(),verifiedBy:row.verified_by,
      verifiedAt:new Date(row.verified_at).toISOString()
    }};
    const existing=await this.pool.query<{created_by:string;verification_status:string;provider_entity_registry_id:string;tenant_id:string;merchant_id:string;provider_key:string}>(
      "SELECT created_by,verification_status,provider_entity_registry_id,tenant_id,merchant_id,provider_key FROM merchant_payout_destinations WHERE id=$1",
      [input.destinationId]);
    if(!existing.rows[0]) return {outcome:"not_found"};
    if(existing.rows[0].created_by===input.actorId) return {outcome:"self_approval"};
    if(existing.rows[0].verification_status!=="pending") return {outcome:"not_pending"};
    return {outcome:"provider_entity_inactive"};
  }

  async revoke(input:{destinationId:string;actorId:string}):Promise<{outcome:"revoked"}|{outcome:"not_found"|"already_revoked"}>{
    const result=await this.pool.query("UPDATE merchant_payout_destinations SET verification_status='revoked',updated_at=now() WHERE id=$1 AND verification_status<>'revoked' RETURNING id",[input.destinationId]);
    if(result.rowCount===1) return {outcome:"revoked"};
    const existing=await this.pool.query<{verification_status:string}>("SELECT verification_status FROM merchant_payout_destinations WHERE id=$1",[input.destinationId]);
    if(!existing.rows[0]) return {outcome:"not_found"};
    return {outcome:"already_revoked"};
  }
}
