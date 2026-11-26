import type {PostgresPool} from "./postgres-iam-store.js";

export interface MerchantPayoutExceptionCaseSummary {
  id:string;tenantId:string;outboxId:string;providerKey:string;providerEventId:string;
  providerReference:string;eventType:"payout_failed"|"payout_canceled"|"payout_returned";
  amountMinor:number;currency:string;reviewStatus:"open"|"under_review"|"resolved";
  reviewStartedBy:string|null;reviewStartedAt:string|null;
  resolutionCode:string|null;resolutionNote:string|null;resolvedBy:string|null;resolvedAt:string|null;
  createdAt:string;
}
type Row={
  id:string;tenant_id:string;outbox_id:string;provider_key:string;provider_event_id:string;
  provider_reference:string;event_type:"payout_failed"|"payout_canceled"|"payout_returned";
  amount_minor:string|number;currency:string;review_status:"open"|"under_review"|"resolved";
  review_started_by:string|null;review_started_at:Date|string|null;
  resolution_code:string|null;resolution_note:string|null;resolved_by:string|null;resolved_at:Date|string|null;
  created_at:Date|string;
};
function iso(value:Date|string|null):string|null{return value===null?null:new Date(value).toISOString();}
function map(row:Row):MerchantPayoutExceptionCaseSummary{
 return {id:row.id,tenantId:row.tenant_id,outboxId:row.outbox_id,providerKey:row.provider_key,
  providerEventId:row.provider_event_id,providerReference:row.provider_reference,eventType:row.event_type,
  amountMinor:Number(row.amount_minor),currency:row.currency,reviewStatus:row.review_status,
  reviewStartedBy:row.review_started_by,reviewStartedAt:iso(row.review_started_at),
  resolutionCode:row.resolution_code,resolutionNote:row.resolution_note,resolvedBy:row.resolved_by,
  resolvedAt:iso(row.resolved_at),createdAt:new Date(row.created_at).toISOString()};
}
const columns=`id,tenant_id,outbox_id,provider_key,provider_event_id,provider_reference,event_type,
 amount_minor,currency,review_status,review_started_by,review_started_at,
 resolution_code,resolution_note,resolved_by,resolved_at,created_at`;

export class PostgresMerchantPayoutExceptionCaseStore {
 constructor(private readonly pool:PostgresPool){}
 async list(input:{status?:"open"|"under_review"|"resolved";limit?:number}={}):Promise<MerchantPayoutExceptionCaseSummary[]>{
  const limit=input.limit??100;
  if(!Number.isSafeInteger(limit)||limit<1||limit>200) throw new Error("INVALID_PAYOUT_EXCEPTION_QUERY");
  const result=await this.pool.query<Row>(
   `SELECT ${columns} FROM merchant_payout_exception_cases
    WHERE ($1::text IS NULL OR review_status=$1)
    ORDER BY CASE review_status WHEN 'open' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END,
      created_at,id LIMIT $2`,[input.status??null,limit]);
  return result.rows.map(map);
 }
 async startReview(input:{caseId:string;actorId:string}):Promise<
  {outcome:"started";case:MerchantPayoutExceptionCaseSummary}|{outcome:"not_found"|"not_open"}>{
  if(!/^[A-Za-z0-9._:-]{1,160}$/.test(input.caseId)||!/^[A-Za-z0-9._:-]{1,160}$/.test(input.actorId))
   throw new Error("INVALID_PAYOUT_EXCEPTION_REVIEW");
  const result=await this.pool.query<Row>(
   `UPDATE merchant_payout_exception_cases
    SET review_status='under_review',review_started_by=$2,review_started_at=now()
    WHERE id=$1 AND review_status='open' RETURNING ${columns}`,[input.caseId,input.actorId]);
  if(result.rows[0]) return {outcome:"started",case:map(result.rows[0])};
  const existing=await this.pool.query<{review_status:string}>(
   "SELECT review_status FROM merchant_payout_exception_cases WHERE id=$1",[input.caseId]);
  if(!existing.rows[0]) return {outcome:"not_found"};
  return {outcome:"not_open"};
 }
 async resolve(input:{caseId:string;actorId:string;resolutionCode:string;resolutionNote?:string}):Promise<
  {outcome:"resolved";case:MerchantPayoutExceptionCaseSummary}|{outcome:"not_found"|"not_under_review"|"reviewer_cannot_resolve"}>{
  if(!/^[A-Za-z0-9._:-]{1,160}$/.test(input.caseId)||!/^[A-Za-z0-9._:-]{1,160}$/.test(input.actorId)||
   !/^[A-Z0-9_.:-]{1,100}$/.test(input.resolutionCode)||
   (input.resolutionNote!==undefined&&input.resolutionNote.length>2000))
   throw new Error("INVALID_PAYOUT_EXCEPTION_RESOLUTION");
  const result=await this.pool.query<Row>(
   `UPDATE merchant_payout_exception_cases
    SET review_status='resolved',resolution_code=$3,resolution_note=$4,resolved_by=$2,resolved_at=now()
    WHERE id=$1 AND review_status='under_review' AND review_started_by<>$2
    RETURNING ${columns}`,
   [input.caseId,input.actorId,input.resolutionCode,input.resolutionNote??null]);
  if(result.rows[0]) return {outcome:"resolved",case:map(result.rows[0])};
  const existing=await this.pool.query<{review_status:string;review_started_by:string|null}>(
   "SELECT review_status,review_started_by FROM merchant_payout_exception_cases WHERE id=$1",[input.caseId]);
  if(!existing.rows[0]) return {outcome:"not_found"};
  if(existing.rows[0].review_status!=="under_review") return {outcome:"not_under_review"};
  return {outcome:"reviewer_cannot_resolve"};
 }
}
