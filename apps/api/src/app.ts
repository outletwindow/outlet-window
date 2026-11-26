import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { DeliveryCoordinate } from "../../../packages/domain/src/order-editing.js";
import type { UpdateDeliveryDestinationResult } from "../../../packages/domain/src/postgres-customer-order-delivery-updater.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createAuditEvent, type AuditEvent } from "../../../packages/domain/src/audit.js";
import {
  authorize,
  type Actor,
  type AuthorizationDecision,
  type AuthorizationRequest
} from "../../../packages/domain/src/authorization.js";
import { ORDER_STATUSES, type OrderStatus, type OrderTransitionContext } from "../../../packages/domain/src/order-lifecycle.js";
import { INTEGRATION_FAMILIES, IntegrationHub } from "../../../packages/domain/src/integration-hub.js";
import { verifyPaymentProviderWebhook } from "../../../packages/domain/src/payment-adjustment-provider.js";
import { verifyAndParseFulfillmentHandoverEvent, type VerifiedFulfillmentHandoverEvent } from "../../../packages/domain/src/fulfillment-handover-provider.js";
import type { CatalogProductInput, CatalogProductRecord } from "../../../packages/domain/src/postgres-merchant-catalog.js";
import type { MerchantCatalogImportService } from "../../../packages/domain/src/merchant-catalog-import-service.js";
import type { BranchInventorySyncRequest, BranchInventorySyncResult } from "../../../packages/domain/src/branch-inventory-sync.js";
import type { BranchInventoryRecord } from "../../../packages/domain/src/postgres-branch-inventory-reader.js";
import type { InventoryReservationFinalizeResult } from "../../../packages/domain/src/postgres-branch-inventory-reservation-lifecycle.js";
import type { RecordPreparationCheckInput, RecordPreparationCheckResult } from "../../../packages/domain/src/postgres-merchant-order-item-preparation.js";
import type { CreateCustomerCheckoutInput, CustomerCheckoutResult } from "../../../packages/domain/src/postgres-customer-checkout.js";
import type { CourierTaskStatus } from "../../../packages/domain/src/courier-task.js";
import type { MerchantOrderSummary } from "../../../packages/domain/src/postgres-merchant-order-reader.js";
import type {
  SettlementApprovalRole, SettlementApprovalDecision, SettlementApprovalOutcome,
  SettlementDecisionOutcome
} from "../../../packages/domain/src/postgres-merchant-settlement-approval-store.js";
import type {
  SettlementAccountingActorRole, SettlementAccountingPostingOutcome
} from "../../../packages/domain/src/postgres-merchant-settlement-accounting-poster.js";
import type {
  MerchantPayoutRequesterRole, MerchantPayoutReviewerRole, MerchantPayoutDecision,
  MerchantPayoutRequestOutcome, MerchantPayoutDecisionOutcome
} from "../../../packages/domain/src/postgres-merchant-payout-authorization-store.js";

export interface SallaOAuthFlow {
  begin(input: { tenantId: string; integrationId: string }): Promise<{ authorizationUrl: string }>;
  complete(input: { code: string; state: string }): Promise<{ tenantId: string; integrationId: string }>;
}
import {
  resolveActorFromBearerToken,
  type ActorResolutionDependencies
} from "../../../packages/domain/src/actor-resolution.js";

export interface MerchantBranchReader {
  findBranchSummary(input: { merchantId: string; branchId: string }): Promise<{
    merchantId: string;
    branchId: string;
    displayName: string;
    status: "active" | "inactive";
  } | null>;
}

export interface MerchantBranchWriter {
  createBranch(input: {
    merchantId: string;
    branchId: string;
    displayName: string;
    cityCode: string;
    address?: Readonly<Record<string, unknown>>;
    latitude?: number;
    longitude?: number;
  }): Promise<"created" | "already_exists" | "merchant_not_found" | "merchant_inactive">;
  updateBranch(input: { merchantId: string; branchId: string; displayName: string; cityCode: string; address?: Readonly<Record<string, unknown>>; latitude?: number; longitude?: number; status: "active" | "inactive" }): Promise<"updated" | "not_found" | "merchant_not_found" | "merchant_inactive">;
}

export interface CustomerDeliveryDestinationService {
  /** Must resolve the service area and a fresh quote server-side; never accept pricing/zone/branch from the client. */
  update(input: { customerId: string; orderId: string; actorId: string; destination: DeliveryCoordinate }): Promise<UpdateDeliveryDestinationResult>;
}

export interface MerchantCatalogRepository {
  createProduct(input: CatalogProductInput): Promise<CatalogProductRecord>;
  listProducts(tenantId: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  setProductPublication?(input: { tenantId: string; productId: string; published: boolean }): Promise<{ outcome: "updated"; publishedAt: string | null } | { outcome: "not_found" }>;
  listPublishedBranchProducts?(input: { merchantId: string; branchId: string; limit: number }): Promise<Array<Record<string, unknown>>>;
}

export interface CustomerPaymentIntentCheckout { create(input:{customerId:string;orderId:string;idempotencyKey:string}):Promise<import("../../../packages/domain/src/postgres-customer-payment-intent-checkout.js").CustomerPaymentIntentCheckoutResult>; }
export interface CustomerCartRepository {
  get(input:{customerId:string}):Promise<import("../../../packages/domain/src/postgres-customer-cart-store.js").CustomerCart|null>;
  addItem(input:{customerId:string;merchantId:string;branchId:string;productVariantId:string;quantity:number}):Promise<import("../../../packages/domain/src/postgres-customer-cart-store.js").CustomerCart>;
  removeItem(input:{customerId:string;itemId:string}):Promise<import("../../../packages/domain/src/postgres-customer-cart-store.js").CustomerCart|null>;
}
export interface CustomerCheckoutService {
  create(input: CreateCustomerCheckoutInput): Promise<CustomerCheckoutResult>;
}
export interface MerchantSettlementReader {
  list(input: { tenantId: string; merchantId: string; status?: "draft" | "approved"; limit?: number }): Promise<import("../../../packages/domain/src/postgres-merchant-settlement-reader.js").MerchantSettlementBatchSummary[]>;
  get(input: { tenantId: string; merchantId: string; batchId: string }): Promise<import("../../../packages/domain/src/postgres-merchant-settlement-reader.js").MerchantSettlementBatch | null>;
}
export interface MerchantSettlementApprovalService {
  request(input: { batchId: string; requesterId: string; requesterRole: SettlementApprovalRole }): Promise<SettlementApprovalOutcome>;
  listPending(input?: { limit?: number }): Promise<import("../../../packages/domain/src/postgres-merchant-settlement-approval-store.js").SettlementApprovalRequest[]>;
  decide(input: { requestId: string; actorId: string; actorRole: "finance" | "platform_admin" | "platform_owner";
    decision: SettlementApprovalDecision; reason?: string }): Promise<SettlementDecisionOutcome>;
}
export interface MerchantSettlementAccountingPoster {
  post(input: { batchId: string; actorId: string; actorRole: SettlementAccountingActorRole }): Promise<SettlementAccountingPostingOutcome>;
}
export interface MerchantPayoutAuthorizationService {
  request(input: { settlementBatchId: string; amountMinor: number; idempotencyKey: string;
    requesterId: string; requesterRole: MerchantPayoutRequesterRole }): Promise<MerchantPayoutRequestOutcome>;
  listPending(input?: { limit?: number }): Promise<import("../../../packages/domain/src/postgres-merchant-payout-authorization-store.js").MerchantPayoutIntent[]>;
  decide(input: { payoutIntentId: string; actorId: string; actorRole: MerchantPayoutReviewerRole;
    decision: MerchantPayoutDecision; reason?: string }): Promise<MerchantPayoutDecisionOutcome>;
}
export interface MerchantPayoutProviderEntityRegistry {
  register(input: { tenantId: string; merchantId: string; providerKey: string;
    providerMerchantId: string; providerEntityId: string; actorId: string }): Promise<
      { outcome: "created"; entity: import("../../../packages/domain/src/postgres-merchant-payout-provider-entity-registry.js").MerchantPayoutProviderEntity } |
      { outcome: "merchant_not_found" | "identity_conflict" }
    >;
  revoke(input: { entityId: string; actorId: string }): Promise<
    { outcome: "revoked" } | { outcome: "not_found" | "already_revoked" }
  >;
  list(input?: { tenantId?: string; limit?: number }): Promise<
    import("../../../packages/domain/src/postgres-merchant-payout-provider-entity-registry.js").MerchantPayoutProviderEntity[]
  >;
}
export interface MerchantPayoutExceptionCaseStore {
  list(input?:{status?:"open"|"under_review"|"resolved";limit?:number}):Promise<import("../../../packages/domain/src/postgres-merchant-payout-exception-case-store.js").MerchantPayoutExceptionCaseSummary[]>;
  startReview(input:{caseId:string;actorId:string}):Promise<
    {outcome:"started";case:import("../../../packages/domain/src/postgres-merchant-payout-exception-case-store.js").MerchantPayoutExceptionCaseSummary}|
    {outcome:"not_found"|"not_open"}>;
  resolve(input:{caseId:string;actorId:string;resolutionCode:string;resolutionNote?:string}):Promise<
    {outcome:"resolved";case:import("../../../packages/domain/src/postgres-merchant-payout-exception-case-store.js").MerchantPayoutExceptionCaseSummary}|
    {outcome:"not_found"|"not_under_review"|"reviewer_cannot_resolve"}>;
}
export interface MerchantPayoutDestinationRegistry {
  register(input:{tenantId:string;merchantId:string;providerKey:string;currency:string;
    providerEntityRegistryId:string;vaultReference:string;actorId:string}):Promise<
      {outcome:"created";destination:import("../../../packages/domain/src/postgres-merchant-payout-destination-registry.js").MerchantPayoutDestinationSummary}|
      {outcome:"provider_entity_not_found"|"duplicate"}>;
  list(input?:{tenantId?:string;merchantId?:string;limit?:number}):Promise<
    import("../../../packages/domain/src/postgres-merchant-payout-destination-registry.js").MerchantPayoutDestinationSummary[]>;
  verify(input:{destinationId:string;actorId:string}):Promise<
    {outcome:"verified";destination:import("../../../packages/domain/src/postgres-merchant-payout-destination-registry.js").MerchantPayoutDestinationSummary}|
    {outcome:"not_found"|"self_approval"|"not_pending"|"provider_entity_inactive"}>;
  revoke(input:{destinationId:string;actorId:string}):Promise<{outcome:"revoked"}|{outcome:"not_found"|"already_revoked"}>;
}
export interface CustomerPaymentAdjustmentActions {
  getCustomerAdjustment?(input: { orderId: string; adjustmentId: string; customerId: string }): Promise<
    | { outcome: "found"; adjustment: {
        id: string; orderId: string; currency: string; direction: "additional_charge" | "refund";
        amountMinor: number; previousTotalMinor: number; proposedTotalMinor: number;
        status: string; expiresAtUtc: string;
        allocations: Array<{ suborderId: string; merchantId: string; branchId: string;
          componentKind: "product_subtotal" | "delivery"; amountMinor: number; currency: string }>;
      } }
    | { outcome: "not_found" }
  >;
  consent(input: { orderId: string; adjustmentId: string; customerId: string }): Promise<{ outcome: string; submissionId?: string }>;
  consentAndQueue?(input: { orderId: string; adjustmentId: string; customerId: string }): Promise<{ outcome: string; submissionId?: string }>;
  decline(input: { orderId: string; adjustmentId: string; customerId: string }): Promise<{ outcome: string }>;
}
export interface PaymentWebhookInboxWriter {
  record(input: { providerKey: string; providerEventId: string; rawBody: string; adjustmentId?: string; eventType?: string; normalizedStatus?: "succeeded" | "failed" | "ignored" | "unsupported"; providerReference?: string }): Promise<
    | { outcome: "received"; receiptId: string }
    | { outcome: "duplicate"; receiptId: string }
    | { outcome: "event_id_collision" }
  >;
}
export interface PaymentCaptureWebhookHandler {
  process(input: { providerKey: string; rawBody: string; signatureHeader?: string }): Promise<
    | { outcome: "recorded"; captureId: string }
    | { outcome: "duplicate"; captureId: string }
    | { outcome: "identity_collision" }
    | { outcome: "invalid_signature_or_event" }
    | { outcome: "provider_not_configured" }
    | { outcome: "payment_intent_not_found" }
  >;
}
export interface MerchantPayoutConfirmationWebhookHandler {
  process(input: { rawBody: string; headers: Readonly<Record<string, string>> }): Promise<
    | { outcome: "confirmed" | "duplicate"; journalId: string }
    | { outcome: "invalid_signature_or_event" | "provider_not_configured" }
  >;
}
export interface MerchantPayoutExceptionWebhookHandler {
  process(input: { rawBody: string; headers: Readonly<Record<string, string>> }): Promise<
    | { outcome: "recorded" | "duplicate"; caseId: string }
    | { outcome: "invalid_signature_or_event" | "provider_not_configured" }
  >;
}

export interface PaymentRefundWebhookHandler {
  process(input: { providerKey: string; rawBody: string }): Promise<
    | { outcome: "applied" | "ignored" | "reconciliation_required" | "duplicate" }
    | { outcome: "event_id_collision" | "invalid_signature_or_event" | "provider_not_configured" }
  >;
}
export interface FulfillmentHandoverInboxWriter {
  recordAndApply(input: { event: VerifiedFulfillmentHandoverEvent; rawBody: string; nowUtc?: string }): Promise<
    | { outcome: "applied"; receiptId: string }
    | { outcome: "duplicate"; receiptId: string }
    | { outcome: "event_id_collision" }
    | { outcome: "reservation_not_found" }
    | { outcome: "reservation_already_finalized"; status: string }
    | { outcome: "reservation_expired" }
  >;
}
export interface AuditEventWriter { append(event: AuditEvent): Promise<"inserted" | "already_exists">; }
export interface OrderTransitionWriter {
  transitionSuborder(input: { tenantId: string; orderId: string; suborderId: string; nextStatus: OrderStatus; context: OrderTransitionContext; auditEvent: AuditEvent }): Promise<
    | { outcome: "updated"; transition: { ok: true; order: { status: OrderStatus; version: number }; previousStatus: OrderStatus }; parentStatus: OrderStatus }
    | { outcome: "not_found" }
    | { outcome: "conflict" }
    | { outcome: "rejected"; reason: string }
  >;
}

export interface CourierDeliveryEvidenceService {
  requestProofUpload(input: {
    tenantId: string; taskId: string; courierId: string;
    contentType: "image/jpeg" | "image/png" | "image/webp";
    contentLength: number; contentSha256: string;
  }): Promise<
    | { outcome: "upload_created"; uploadId: string; uploadUrl: string; expiresAtUtc: string }
    | { outcome: "not_found" | "task_not_ready" | "upload_unavailable" }
  >;
  finalizeProofUpload(input: {
    tenantId: string; taskId: string; courierId: string; uploadId: string;
  }): Promise<
    | { outcome: "verified"; evidenceId: string; verifiedAtUtc: string }
    | { outcome: "not_found" | "task_not_ready" | "upload_missing" | "checksum_mismatch" | "invalid_upload" }
  >;
}

export interface AppOptions {
  serviceName?: string;
  version?: string;
  /** Resolve an authenticated principal from a verified session; never trust client-supplied role headers. */
  resolveActor?: (request: FastifyRequest) => Promise<Actor | null>;
  /** Optional trusted persistence/crypto adapters for resolving real bearer sessions. */
  actorResolution?: ActorResolutionDependencies;
  /** Repository adapter must apply merchantId and branchId predicates in its database query. */
  merchantBranches?: MerchantBranchReader;
  merchantOrderReader?: { listForBranch(input: { tenantId: string; merchantId: string; branchId: string; status?: OrderStatus; limit?: number }): Promise<MerchantOrderSummary[]> };
  merchantSettlementReader?: MerchantSettlementReader;
  merchantSettlementApprovals?: MerchantSettlementApprovalService;
  merchantSettlementAccountingPoster?: MerchantSettlementAccountingPoster;
  merchantPayoutAuthorization?: MerchantPayoutAuthorizationService;
  merchantPayoutProviderEntities?: MerchantPayoutProviderEntityRegistry;
  merchantPayoutDestinations?: MerchantPayoutDestinationRegistry;
  merchantPayoutExceptionCases?: MerchantPayoutExceptionCaseStore;
  merchantPayoutProviderOutbox?: {
    enqueue(input: {
      payoutIntentId: string; destinationId: string;
      providerKey: string; idempotencyKey: string; actorId: string;
    }): Promise<
      | { outcome: "queued"; outboxId: string }
      | { outcome: "not_found" | "not_authorized" | "destination_unverified" | "provider_entity_inactive" | "idempotency_conflict" }
    >;
  };
  merchantBranchWriter?: MerchantBranchWriter;
  /** Optional dependency check used by readiness; failures keep the instance out of service. */
  readinessCheck?: () => Promise<boolean>;
  /** Durable audit writer. Protected operations are not executed if their audit write fails. */
  auditEvents?: AuditEventWriter;
  orderTransitions?: OrderTransitionWriter;
  courierDeliveryEvidence?: CourierDeliveryEvidenceService;
  courierPickupCodeIssuer?: {
    issue(input: {
      tenantId: string; merchantId: string; branchId: string; orderId: string;
      suborderId: string; taskId: string; actorId: string;
      actorRole: "merchant_employee" | "branch_manager" | "merchant_admin" | "merchant_owner";
    }): Promise<
      | { outcome: "issued"; code: string; expiresAtUtc: string }
      | { outcome: "not_found" | "not_ready" | "invalid_actor" | "rate_limited" }
    >;
  };
  courierTasks?: {
    listForCourier(input: { tenantId: string; courierId: string; limit?: number }): Promise<import("../../../packages/domain/src/courier-task.js").CourierTask[]>;
    transition(input: { tenantId: string; taskId: string; courierId: string; nextStatus: CourierTaskStatus; expectedVersion: number; pickupCode?: string; reason?: string }): Promise<import("../../../packages/domain/src/postgres-courier-task-store.js").CourierTaskTransitionOutcome>;
  };
  courierDispatchOffers?: {
    listForCourier(input: { tenantId: string; courierId: string; limit?: number }): Promise<import("../../../packages/domain/src/postgres-courier-dispatch-offer-store.js").CourierDispatchOfferSummary[]>;
  };
  courierDispatchOfferCommands?: {
    respond(input: {
      tenantId: string; offerId: string; courierId: string; expectedVersion: number;
      decision: "accepted" | "declined"; reason?: string;
    }): Promise<import("../../../packages/domain/src/postgres-courier-dispatch-offer-command-store.js").CourierDispatchOfferResponse>;
  };
  courierAdminProfiles?: {
    listVehicles(input?: { status?: "pending" | "verified" | "rejected"; limit?: number }): Promise<import("../../../packages/domain/src/postgres-courier-admin-store.js").CourierAdminVehicle[]>;
    listProfiles(input?: { status?: "pending" | "active" | "suspended"; limit?: number }): Promise<import("../../../packages/domain/src/postgres-courier-admin-store.js").CourierAdminProfile[]>;
    createProfile(input: { courierId: string; maxConcurrentTasks: number }): Promise<"created" | "identity_not_found" | "identity_not_eligible" | "already_exists">;
    reviewProfile(input: { courierId: string; decision: "approve" | "reject" | "suspend" | "reinstate"; reviewerId: string }): Promise<"updated" | "not_found" | "invalid_transition">;
    registerVehicle(input: { vehicleId: string; courierId: string; vehicleType: "motorcycle" | "car" | "van"; capacityWeightGrams: number; capacityVolumeLiters: number }): Promise<"created" | "courier_not_found" | "courier_not_active" | "already_exists">;
    reviewVehicle(input: { vehicleId: string; decision: "approve" | "reject"; reviewerId: string }): Promise<"updated" | "not_found" | "invalid_transition">;
    grantServiceArea(input: { courierId: string; tenantId: string; serviceAreaId: string; reviewerId: string }): Promise<"granted" | "courier_not_found" | "courier_not_active" | "service_area_not_active">;
    revokeServiceArea(input: { courierId: string; tenantId: string; serviceAreaId: string }): Promise<"revoked" | "not_found">;
  };
  courierAvailability?: {
    setAvailability(input: { courierId: string; available: boolean }): Promise<import("../../../packages/domain/src/postgres-courier-availability-store.js").CourierAvailabilityUpdate>;
  };
  merchantOrderItemPreparation?: { record(input: RecordPreparationCheckInput): Promise<RecordPreparationCheckResult> };
  customerDeliveryDestinations?: CustomerDeliveryDestinationService;
  customerPaymentAdjustments?: CustomerPaymentAdjustmentActions;
  customerPaymentIntentCheckout?: CustomerPaymentIntentCheckout;
  customerCart?: CustomerCartRepository;
  customerCheckout?: CustomerCheckoutService;
  integrationHub?: IntegrationHub;
  /** Platform-only authority for explicit POS/ERP hard-reservation branch grants. */
  inventoryProviderBranchScopes?: {
    approveHardReservationCapability(input: { tenantId: string; integrationId: string }): Promise<"approved" | "not_eligible">;
    grant(input: { tenantId: string; integrationId: string; merchantId: string; branchId: string }): Promise<"granted" | "not_eligible">;
    revoke(input: { tenantId: string; integrationId: string; merchantId: string; branchId: string }): Promise<"revoked" | "not_found">;
  };
  merchantCatalog?: MerchantCatalogRepository;
  /** Resolve merchant tenant ownership from trusted persistence after authorization. */
  resolveMerchantTenantId?: (merchantId: string) => Promise<string | null>;
  merchantCatalogImport?: MerchantCatalogImportService;
  paymentWebhookInbox?: PaymentWebhookInboxWriter;
  paymentCaptureWebhookHandler?: PaymentCaptureWebhookHandler;
  paymentRefundWebhookHandler?: PaymentRefundWebhookHandler;
  merchantPayoutConfirmationWebhook?: MerchantPayoutConfirmationWebhookHandler;
  merchantPayoutExceptionWebhook?: MerchantPayoutExceptionWebhookHandler;
  paymentWebhookSecretResolver?: (providerKey: string) => Promise<string | null>;
  fulfillmentHandoverInbox?: FulfillmentHandoverInboxWriter;
  fulfillmentWebhookSecretResolver?: (providerKey: string) => Promise<string | null>;
  /** Must bind provider identity to the exact tenant, merchant, and branch before stock is consumed. */
  fulfillmentWebhookAuthorizationResolver?: (providerKey: string, event: VerifiedFulfillmentHandoverEvent) => Promise<boolean>;
  sallaOAuthFlow?: SallaOAuthFlow;
  branchInventorySync?: { sync(input: BranchInventorySyncRequest): Promise<BranchInventorySyncResult> };
  branchInventoryReader?: {
    list(input: { tenantId: string; merchantId: string; branchId: string; limit?: number }): Promise<readonly BranchInventoryRecord[]>;
    listOpenReconciliationAlerts?(input: { tenantId: string; merchantId: string; branchId: string; limit?: number }): Promise<readonly {
      id: string; productVariantId: string; source: "pos" | "erp" | "ecommerce" | "csv" | "merchant_portal" | "manual";
      capturedAtUtc: string; reportedAvailableQuantity: number; platformReservedQuantity: number; createdAtUtc: string;
    }[]>;
  };
  inventoryReservationLifecycle?: {
    release(input: { tenantId: string; merchantId: string; branchId: string; reservationId: string; nowUtc: string; reason: string }): Promise<InventoryReservationFinalizeResult>;
    expire(input: { tenantId: string; merchantId: string; branchId: string; reservationId: string; nowUtc: string }): Promise<InventoryReservationFinalizeResult>;
    consume(input: { tenantId: string; merchantId: string; branchId: string; reservationId: string; nowUtc: string; handoverVerified: boolean; handoverReference: string }): Promise<InventoryReservationFinalizeResult>;
  };
}

const paymentWebhookRawBodies = new WeakMap<FastifyRequest, string>();
const merchantPayoutWebhookRawBodies = new WeakMap<FastifyRequest, string>();
const fulfillmentWebhookRawBodies = new WeakMap<FastifyRequest, string>();

type AuthorizationResult =
  | { actor: Actor; decision: AuthorizationDecision & { allowed: true } }
  | { actor: null; decision: AuthorizationDecision & { allowed: false }; statusCode: 401 | 403 };

async function authorizeRequest(
  request: FastifyRequest,
  options: AppOptions,
  authorizationRequest: AuthorizationRequest | ((actor: Actor) => AuthorizationRequest)
): Promise<AuthorizationResult> {
  let actor: Actor | null = null;
  if (options.actorResolution) {
    const header = request.headers.authorization;
    const resolved = await resolveActorFromBearerToken({
      authorizationHeader: Array.isArray(header) ? header[0] : header,
      dependencies: options.actorResolution
    });
    actor = resolved.actor;
  } else {
    actor = await options.resolveActor?.(request) ?? null;
  }

  if (!actor) {
    return {
      actor: null,
      decision: { allowed: false, reason: "missing_identity" },
      statusCode: 401
    };
  }

  const resolvedAuthorizationRequest = typeof authorizationRequest === "function" ? authorizationRequest(actor) : authorizationRequest;
  const decision = authorize(actor, resolvedAuthorizationRequest);
  if (options.auditEvents) {
    const merchantId = resolvedAuthorizationRequest.scope.merchantId;
    await options.auditEvents.append(createAuditEvent({
      id: randomUUID(),
      type: decision.allowed ? `authorization.${resolvedAuthorizationRequest.action}.granted` : `authorization.${resolvedAuthorizationRequest.action}.denied`,
      category: "access_control",
      occurredAt: new Date().toISOString(),
      actor: { id: actor.id, type: actor.role === "merchant_owner" || actor.role === "merchant_admin" ||
        actor.role === "branch_manager" || actor.role === "merchant_employee" ? "merchant_user" :
        actor.role === "customer" ? "customer" : actor.role === "shopper" ? "shopper" :
        actor.role === "courier" ? "courier" : actor.role === "ai_agent" ? "ai_agent" : "platform_user",
        role: actor.role },
      action: `${resolvedAuthorizationRequest.resource}:${resolvedAuthorizationRequest.action}`,
      outcome: decision.allowed ? "success" : "denied",
      resourceType: resolvedAuthorizationRequest.resource,
      ...(resolvedAuthorizationRequest.scope.branchId ? { resourceId: resolvedAuthorizationRequest.scope.branchId, branchId: resolvedAuthorizationRequest.scope.branchId } : {}),
      ...(merchantId ? { tenantId: merchantId, merchantId } : {}),
      correlationId: request.id,
      source: "api",
      severity: decision.allowed ? "info" : "warning",
      metadata: { authorizationReason: decision.reason }
    }));
  }
  if (!decision.allowed) {
    return { actor: null, decision, statusCode: 403 };
  }
  return { actor, decision };
}

function sendAuthorizationFailure(
  reply: FastifyReply,
  statusCode: 401 | 403,
  reason?: string
) {
  return reply.code(statusCode).send({
    error: statusCode === 401 ? "unauthenticated" : "forbidden",
    ...(statusCode === 403 && reason ? { reason } : {})
  });
}

/** Explicit API projection prevents persistence-only fields (including pickup credentials) from leaking. */
function serializeCourierTask(task: import("../../../packages/domain/src/courier-task.js").CourierTask) {
  return {
    id: task.id,
    tenantId: task.tenantId,
    orderId: task.orderId,
    suborderId: task.suborderId,
    courierId: task.courierId,
    status: task.status,
    version: task.version,
    updatedAtUtc: task.updatedAtUtc
  };
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    trustProxy: false,
    bodyLimit: 1_048_576
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-correlation-id", request.id);
  });

  const serviceName = options.serviceName ?? "outlet-window-api";
  const version = options.version ?? "0.1.0";

  app.get("/health", async () => ({
    status: "ok",
    service: serviceName,
    version
  }));

  app.get("/ready", async (_request, reply) => {
    let database: "ok" | "unavailable" = "ok";
    if (options.readinessCheck) {
      try { if (!(await options.readinessCheck())) database = "unavailable"; }
      catch { database = "unavailable"; }
    }
    const ready = database === "ok";
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      checks: { process: "ok", ...(options.readinessCheck ? { database } : {}) }
    });
  });

  app.get("/api/v1", async () => ({
    name: "Outlet Window API",
    version: "v1",
    status: "foundation"
  }));

  app.put<{ Body: unknown }>("/api/v1/courier/availability", async (request, reply) => {
    const auth = await authorizeRequest(request, options, actor => ({
      resource: "courier.delivery_task", action: "update",
      scope: { merchantId: actor.grants.find(g => g.resource === "courier.delivery_task" && g.actions.includes("update") && g.scope.merchantId)?.scope.merchantId ?? "" }
    }));
    if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
    if (!(auth.actor.roles ?? [auth.actor.role]).includes("courier")) return reply.code(403).send({ error: "courier_only" });
    if (!options.courierAvailability) return reply.code(503).send({ error: "courier_availability_unavailable" });
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.available !== "boolean" || Object.keys(body).some(key => key !== "available")) {
      return reply.code(400).send({ error: "invalid_courier_availability" });
    }
    const result = await options.courierAvailability.setAvailability({
      courierId: auth.actor.id, available: body.available
    });
    if (result.outcome === "not_found") return reply.code(404).send({ error: "courier_profile_not_found" });
    if (result.outcome === "not_eligible") return reply.code(409).send({ error: "courier_profile_not_eligible" });
    return reply.code(200).send(result);
  });

  app.get("/api/v1/courier/offers", async (request, reply) => {
    const auth = await authorizeRequest(request, options, actor => ({
      resource: "courier.delivery_task", action: "read",
      scope: { merchantId: actor.grants.find(g => g.resource === "courier.delivery_task" && g.actions.includes("read") && g.scope.merchantId)?.scope.merchantId ?? "" }
    }));
    if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
    if (!(auth.actor.roles ?? [auth.actor.role]).includes("courier")) return reply.code(403).send({ error: "courier_only" });
    if (!options.courierDispatchOffers) return reply.code(503).send({ error: "courier_dispatch_offers_unavailable" });
    const tenantIds = [...new Set(auth.actor.grants
      .filter(g => g.resource === "courier.delivery_task" && g.actions.includes("read") && g.scope.merchantId)
      .map(g => g.scope.merchantId!))];
    const offers = (await Promise.all(tenantIds.map(tenantId =>
      options.courierDispatchOffers!.listForCourier({ tenantId, courierId: auth.actor!.id, limit: 100 })
    ))).flat();
    return reply.code(200).send({ offers });
  });

  app.post<{ Params: { offerId: string }; Body: unknown }>(
    "/api/v1/courier/offers/:offerId/respond", async (request, reply) => {
      const auth = await authorizeRequest(request, options, actor => ({
        resource: "courier.delivery_task", action: "update",
        scope: { merchantId: actor.grants.find(g => g.resource === "courier.delivery_task" && g.actions.includes("update") && g.scope.merchantId)?.scope.merchantId ?? "" }
      }));
      if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
      if (!(auth.actor.roles ?? [auth.actor.role]).includes("courier")) return reply.code(403).send({ error: "courier_only" });
      if (!options.courierDispatchOfferCommands) return reply.code(503).send({ error: "courier_dispatch_offer_commands_unavailable" });
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(request.params.offerId)) {
        return reply.code(400).send({ error: "invalid_courier_dispatch_offer_id" });
      }
      const body = request.body as Record<string, unknown> | null;
      if (!body || !["accepted", "declined"].includes(String(body.decision)) ||
          !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1 ||
          (body.decision === "declined" && (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 500)) ||
          (body.decision === "accepted" && body.reason !== undefined)) {
        return reply.code(400).send({ error: "invalid_courier_dispatch_offer_response" });
      }
      const tenantIds = [...new Set(auth.actor.grants
        .filter(g => g.resource === "courier.delivery_task" && g.actions.includes("update") && g.scope.merchantId)
        .map(g => g.scope.merchantId!))];
      for (const tenantId of tenantIds) {
        const result = await options.courierDispatchOfferCommands.respond({
          tenantId, offerId: request.params.offerId, courierId: auth.actor.id,
          expectedVersion: body.expectedVersion as number,
          decision: body.decision as "accepted" | "declined",
          ...(body.reason === undefined ? {} : { reason: body.reason as string })
        });
        if (result.outcome === "not_found") continue;
        if (result.outcome === "eligibility_unavailable") return reply.code(503).send({ error: "courier_eligibility_unavailable" });
        if (result.outcome === "courier_ineligible") return reply.code(409).send({ error: "courier_no_longer_eligible" });
        if (result.outcome === "already_assigned") return reply.code(409).send({ error: "courier_suborder_already_assigned" });
        if (result.outcome === "conflict") return reply.code(409).send({ error: "courier_dispatch_offer_conflict" });
        if (result.outcome === "expired") return reply.code(409).send({ error: "courier_dispatch_offer_expired" });
        return reply.code(200).send(result);
      }
      return reply.code(404).send({ error: "courier_dispatch_offer_not_found" });
    }
  );

  app.get("/api/v1/courier/tasks", async (request, reply) => {
    const auth = await authorizeRequest(request, options, actor => ({
      resource: "courier.delivery_task", action: "read",
      scope: { merchantId: actor.grants.find(g => g.resource === "courier.delivery_task" && g.actions.includes("read") && g.scope.merchantId)?.scope.merchantId ?? "" }
    }));
    if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
    if (!(auth.actor.roles ?? [auth.actor.role]).includes("courier")) return reply.code(403).send({ error: "courier_only" });
    if (!options.courierTasks) return reply.code(503).send({ error: "courier_tasks_unavailable" });
    const merchantIds = [...new Set(auth.actor.grants
      .filter(g => g.resource === "courier.delivery_task" && g.actions.includes("read") && g.scope.merchantId)
      .map(g => g.scope.merchantId!))];
    const tasks = (await Promise.all(merchantIds.map(tenantId =>
      options.courierTasks!.listForCourier({ tenantId, courierId: auth.actor!.id, limit: 100 })
    ))).flat();
    return reply.code(200).send({ tasks: tasks.map(serializeCourierTask) });
  });

  app.post<{ Params: { taskId: string }; Body: unknown }>(
    "/api/v1/courier/tasks/:taskId/proof-upload", async (request, reply) => {
      const auth = await authorizeRequest(request, options, actor => ({
        resource: "courier.delivery_task", action: "update",
        scope: { merchantId: actor.grants.find(g => g.resource === "courier.delivery_task" && g.actions.includes("update") && g.scope.merchantId)?.scope.merchantId ?? "" }
      }));
      if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
      if (!(auth.actor.roles ?? [auth.actor.role]).includes("courier")) return reply.code(403).send({ error: "courier_only" });
      if (!options.courierDeliveryEvidence) return reply.code(503).send({ error: "courier_delivery_evidence_unavailable" });
      const body = request.body as Record<string, unknown> | null;
      const contentTypes = ["image/jpeg", "image/png", "image/webp"] as const;
      if (!body || !contentTypes.includes(body.contentType as typeof contentTypes[number]) ||
          !Number.isSafeInteger(body.contentLength) || (body.contentLength as number) < 1 ||
          (body.contentLength as number) > 10 * 1024 * 1024 ||
          typeof body.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.contentSha256)) {
        return reply.code(400).send({ error: "invalid_delivery_proof_upload" });
      }
      const tenantIds = [...new Set(auth.actor.grants
        .filter(g => g.resource === "courier.delivery_task" && g.actions.includes("update") && g.scope.merchantId)
        .map(g => g.scope.merchantId!))];
      for (const tenantId of tenantIds) {
        const result = await options.courierDeliveryEvidence.requestProofUpload({
          tenantId, taskId: request.params.taskId, courierId: auth.actor.id,
          contentType: body.contentType as typeof contentTypes[number],
          contentLength: body.contentLength as number, contentSha256: body.contentSha256
        });
        if (result.outcome === "not_found") continue;
        if (result.outcome === "task_not_ready") return reply.code(409).send({ error: "courier_task_not_ready_for_delivery_proof" });
        if (result.outcome === "upload_unavailable") return reply.code(503).send({ error: "delivery_proof_storage_unavailable" });
        if (result.outcome !== "upload_created") return reply.code(503).send({ error: "delivery_proof_upload_unavailable" });
        return reply.code(201).send({
          uploadId: result.uploadId, uploadUrl: result.uploadUrl, expiresAtUtc: result.expiresAtUtc,
          requiredHeaders: { "content-type": body.contentType, "if-none-match": "*" }
        });
      }
      return reply.code(404).send({ error: "courier_task_not_found" });
    }
  );

  app.post<{ Params: { taskId: string; uploadId: string }; Body: unknown }>(
    "/api/v1/courier/tasks/:taskId/proof-upload/:uploadId/complete", async (request, reply) => {
      const auth = await authorizeRequest(request, options, actor => ({
        resource: "courier.delivery_task", action: "update",
        scope: { merchantId: actor.grants.find(g => g.resource === "courier.delivery_task" && g.actions.includes("update") && g.scope.merchantId)?.scope.merchantId ?? "" }
      }));
      if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
      if (!(auth.actor.roles ?? [auth.actor.role]).includes("courier")) return reply.code(403).send({ error: "courier_only" });
      if (!options.courierDeliveryEvidence) return reply.code(503).send({ error: "courier_delivery_evidence_unavailable" });
      if (!/^[a-zA-Z0-9_-]{8,128}$/.test(request.params.uploadId)) {
        return reply.code(400).send({ error: "invalid_delivery_proof_upload_id" });
      }
      const tenantIds = [...new Set(auth.actor.grants
        .filter(g => g.resource === "courier.delivery_task" && g.actions.includes("update") && g.scope.merchantId)
        .map(g => g.scope.merchantId!))];
      for (const tenantId of tenantIds) {
        const result = await options.courierDeliveryEvidence.finalizeProofUpload({
          tenantId, taskId: request.params.taskId, courierId: auth.actor.id, uploadId: request.params.uploadId
        });
        if (result.outcome === "not_found") continue;
        if (result.outcome === "task_not_ready") return reply.code(409).send({ error: "courier_task_not_ready_for_delivery_proof" });
        if (result.outcome === "upload_missing") return reply.code(409).send({ error: "delivery_proof_object_missing" });
        if (result.outcome === "checksum_mismatch") return reply.code(422).send({ error: "delivery_proof_checksum_mismatch" });
        if (result.outcome === "invalid_upload") return reply.code(422).send({ error: "delivery_proof_upload_invalid" });
        if (result.outcome !== "verified") return reply.code(503).send({ error: "delivery_proof_verification_unavailable" });
        return reply.code(200).send({ outcome: result.outcome, evidenceId: result.evidenceId, verifiedAtUtc: result.verifiedAtUtc });
      }
      return reply.code(404).send({ error: "courier_task_not_found" });
    }
  );

  app.patch<{ Params: { taskId: string }; Body: unknown }>(
    "/api/v1/courier/tasks/:taskId/status", async (request, reply) => {
      const auth = await authorizeRequest(request, options, actor => ({
        resource: "courier.delivery_task", action: "update",
        scope: { merchantId: actor.grants.find(g => g.resource === "courier.delivery_task" && g.actions.includes("update") && g.scope.merchantId)?.scope.merchantId ?? "" }
      }));
      if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
      if (!(auth.actor.roles ?? [auth.actor.role]).includes("courier")) return reply.code(403).send({ error: "courier_only" });
      if (!options.courierTasks) return reply.code(503).send({ error: "courier_tasks_unavailable" });
      const body = request.body as Record<string, unknown> | null;
      const statuses: CourierTaskStatus[] = ["accepted","heading_to_pickup","arrived_at_pickup","picked_up","in_transit","arrived_at_dropoff","delivered","declined","failed"];
      if (!body || typeof body.status !== "string" || !statuses.includes(body.status as CourierTaskStatus) ||
          !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1 ||
          (body.pickupCode !== undefined && (typeof body.pickupCode !== "string" || !/^\d{8}$/.test(body.pickupCode))) ||
          (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500))) {
        return reply.code(400).send({ error: "invalid_courier_task_transition" });
      }
      const tenantIds = [...new Set(auth.actor.grants
        .filter(g => g.resource === "courier.delivery_task" &&
          g.actions.includes("update") && g.scope.merchantId)
        .map(g => g.scope.merchantId!))];
      if (!tenantIds.length) return reply.code(403).send({ error: "courier_tenant_scope_missing" });
      const transitionInput = {
        taskId: request.params.taskId, courierId: auth.actor.id,
        nextStatus: body.status as CourierTaskStatus, expectedVersion: body.expectedVersion as number,
        ...(typeof body.pickupCode === "string" ? { pickupCode: body.pickupCode } : {}),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {})
      };
      // Probe only explicitly granted tenant scopes; stop on the first definitive result.
      for (const tenantId of tenantIds) {
        const result = await options.courierTasks.transition({ tenantId, ...transitionInput });
        if (result.outcome === "not_found") continue;
        if (result.outcome === "conflict") return reply.code(409).send({ error: "courier_task_version_conflict" });
        if (result.outcome === "rejected") return reply.code(422).send({ error: result.reason ?? "courier_task_transition_rejected" });
        if (result.outcome === "updated") return reply.code(200).send({ task: serializeCourierTask(result.task) });
      }
      return reply.code(404).send({ error: "courier_task_not_found" });
    }
  );

  // Courier onboarding and approval are restricted to platform administrators.
  app.get<{ Querystring: { status?: string; limit?: string } }>("/api/v1/platform/couriers", async (request, reply) => {
    const auth = await authorizeRequest(request, options, {
      resource: "platform.courier_profile", action: "read", scope: { platform: true }
    });
    if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
    const roles = new Set([auth.actor.role, ...(auth.actor.roles ?? [])]);
    if (![...roles].some(role => role === "platform_owner" || role === "platform_admin")) {
      return reply.code(403).send({ error: "platform_admin_only" });
    }
    if (!options.courierAdminProfiles) return reply.code(503).send({ error: "courier_admin_unavailable" });
    const status = request.query.status;
    if (status !== undefined && !["pending", "active", "suspended"].includes(status)) {
      return reply.code(400).send({ error: "invalid_courier_profile_status" });
    }
    const parsedLimit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      return reply.code(400).send({ error: "invalid_limit" });
    }
    const profiles = await options.courierAdminProfiles.listProfiles({
      ...(status === undefined ? {} : { status: status as "pending" | "active" | "suspended" }),
      limit: parsedLimit
    });
    return reply.code(200).send({ profiles });
  });

  app.post<{ Body: unknown }>("/api/v1/platform/couriers", async (request, reply) => {
    const auth = await authorizeRequest(request, options, {
      resource: "platform.courier_profile", action: "create", scope: { platform: true }
    });
    if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
    const roles = new Set([auth.actor.role, ...(auth.actor.roles ?? [])]);
    if (![...roles].some(role => role === "platform_owner" || role === "platform_admin")) {
      return reply.code(403).send({ error: "platform_admin_only" });
    }
    if (!options.courierAdminProfiles || !options.auditEvents) return reply.code(503).send({ error: "courier_admin_unavailable" });
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.courierId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(body.courierId) ||
        !Number.isSafeInteger(body.maxConcurrentTasks ?? 1) || Number(body.maxConcurrentTasks ?? 1) < 1 || Number(body.maxConcurrentTasks ?? 1) > 20 ||
        Object.keys(body).some(key => !["courierId", "maxConcurrentTasks"].includes(key))) {
      return reply.code(400).send({ error: "invalid_courier_profile" });
    }
    const auditBase = {
      id: randomUUID(), category: "courier_governance", occurredAt: new Date().toISOString(),
      actor: { id: auth.actor.id, type: "platform_user" as const, role: auth.actor.role },
      action: "platform.courier_profile.create", resourceType: "courier_profile",
      resourceId: body.courierId, correlationId: request.id, source: "api", severity: "high" as const,
      metadata: { maxConcurrentTasks: Number(body.maxConcurrentTasks ?? 1) }
    };
    await options.auditEvents.append(createAuditEvent({ ...auditBase, type: "courier_profile.creation.requested", outcome: "pending" }));
    const outcome = await options.courierAdminProfiles.createProfile({
      courierId: body.courierId, maxConcurrentTasks: Number(body.maxConcurrentTasks ?? 1)
    });
    await options.auditEvents.append(createAuditEvent({
      ...auditBase, id: randomUUID(),
      type: outcome === "created" ? "courier_profile.created" : "courier_profile.creation_rejected",
      outcome: outcome === "created" ? "success" : "failure"
    }));
    if (outcome === "identity_not_found") return reply.code(404).send({ error: "courier_identity_not_found" });
    if (outcome === "identity_not_eligible") return reply.code(409).send({ error: "courier_identity_not_eligible" });
    if (outcome === "already_exists") return reply.code(409).send({ error: "courier_profile_already_exists" });
    return reply.code(201).send({ outcome, courierId: body.courierId, accountStatus: "pending", verificationStatus: "pending" });
  });

  app.post<{ Params: { courierId: string }; Body: unknown }>(
    "/api/v1/platform/couriers/:courierId/review", async (request, reply) => {
      const auth = await authorizeRequest(request, options, {
        resource: "platform.courier_profile", action: "approve", scope: { platform: true }
      });
      if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
      const roles = new Set([auth.actor.role, ...(auth.actor.roles ?? [])]);
      if (![...roles].some(role => role === "platform_owner" || role === "platform_admin")) {
        return reply.code(403).send({ error: "platform_admin_only" });
      }
      if (!options.courierAdminProfiles || !options.auditEvents) return reply.code(503).send({ error: "courier_admin_unavailable" });
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(request.params.courierId)) return reply.code(400).send({ error: "invalid_courier_id" });
      const body = request.body as Record<string, unknown> | null;
      if (!body || !["approve", "reject", "suspend", "reinstate"].includes(String(body.decision)) ||
          Object.keys(body).some(key => key !== "decision")) return reply.code(400).send({ error: "invalid_courier_review" });
      const decision = body.decision as "approve" | "reject" | "suspend" | "reinstate";
      const auditBase = {
        id: randomUUID(), category: "courier_governance", occurredAt: new Date().toISOString(),
        actor: { id: auth.actor.id, type: "platform_user" as const, role: auth.actor.role },
        action: `platform.courier_profile.${decision}`, resourceType: "courier_profile",
        resourceId: request.params.courierId, correlationId: request.id, source: "api", severity: "high" as const,
        metadata: { decision }
      };
      await options.auditEvents.append(createAuditEvent({ ...auditBase, type: "courier_profile.review.requested", outcome: "pending" }));
      const outcome = await options.courierAdminProfiles.reviewProfile({
        courierId: request.params.courierId, decision, reviewerId: auth.actor.id
      });
      await options.auditEvents.append(createAuditEvent({
        ...auditBase, id: randomUUID(),
        type: outcome === "updated" ? "courier_profile.reviewed" : "courier_profile.review_rejected",
        outcome: outcome === "updated" ? "success" : "failure"
      }));
      if (outcome === "not_found") return reply.code(404).send({ error: "courier_profile_not_found" });
      if (outcome === "invalid_transition") return reply.code(409).send({ error: "courier_profile_review_conflict" });
      return reply.code(200).send({ outcome, courierId: request.params.courierId, decision });
    }
  );

  app.get<{ Querystring: { status?: string; limit?: string } }>("/api/v1/platform/courier-vehicles", async (request, reply) => {
    const auth = await authorizeRequest(request, options, {
      resource: "platform.courier_profile", action: "read", scope: { platform: true }
    });
    if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
    const roles = new Set([auth.actor.role, ...(auth.actor.roles ?? [])]);
    if (![...roles].some(role => role === "platform_owner" || role === "platform_admin")) return reply.code(403).send({ error: "platform_admin_only" });
    if (!options.courierAdminProfiles) return reply.code(503).send({ error: "courier_admin_unavailable" });
    const status = request.query.status;
    if (status !== undefined && !["pending", "verified", "rejected"].includes(status)) return reply.code(400).send({ error: "invalid_courier_vehicle_status" });
    const parsedLimit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) return reply.code(400).send({ error: "invalid_limit" });
    const vehicles = await options.courierAdminProfiles.listVehicles({
      ...(status === undefined ? {} : { status: status as "pending" | "verified" | "rejected" }), limit: parsedLimit
    });
    return reply.code(200).send({ vehicles });
  });

  app.post<{ Body: unknown }>("/api/v1/platform/courier-vehicles", async (request, reply) => {
    const auth = await authorizeRequest(request, options, {
      resource: "platform.courier_profile", action: "create", scope: { platform: true }
    });
    if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
    const roles = new Set([auth.actor.role, ...(auth.actor.roles ?? [])]);
    if (![...roles].some(role => role === "platform_owner" || role === "platform_admin")) return reply.code(403).send({ error: "platform_admin_only" });
    if (!options.courierAdminProfiles || !options.auditEvents) return reply.code(503).send({ error: "courier_admin_unavailable" });
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.courierId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(body.courierId) ||
        !["motorcycle", "car", "van"].includes(String(body.vehicleType)) ||
        !Number.isSafeInteger(body.capacityWeightGrams) || Number(body.capacityWeightGrams) < 1 || Number(body.capacityWeightGrams) > 1_000_000 ||
        !Number.isSafeInteger(body.capacityVolumeLiters) || Number(body.capacityVolumeLiters) < 1 || Number(body.capacityVolumeLiters) > 10_000 ||
        Object.keys(body).some(key => !["courierId", "vehicleType", "capacityWeightGrams", "capacityVolumeLiters"].includes(key))) {
      return reply.code(400).send({ error: "invalid_courier_vehicle" });
    }
    const vehicleId = randomUUID();
    const outcome = await options.courierAdminProfiles.registerVehicle({
      vehicleId, courierId: body.courierId, vehicleType: body.vehicleType as "motorcycle" | "car" | "van",
      capacityWeightGrams: Number(body.capacityWeightGrams), capacityVolumeLiters: Number(body.capacityVolumeLiters)
    });
    await options.auditEvents.append(createAuditEvent({
      id: randomUUID(), type: outcome === "created" ? "courier_vehicle.registration_created" : "courier_vehicle.registration_rejected",
      category: "courier_governance", occurredAt: new Date().toISOString(),
      actor: { id: auth.actor.id, type: "platform_user", role: auth.actor.role },
      action: "platform.courier_vehicle.register", outcome: outcome === "created" ? "success" : "failure",
      resourceType: "courier_vehicle", resourceId: vehicleId, correlationId: request.id, source: "api", severity: "high",
      metadata: { courierId: body.courierId, vehicleType: body.vehicleType }
    }));
    if (outcome === "courier_not_found") return reply.code(404).send({ error: "courier_profile_not_found" });
    if (outcome === "courier_not_active") return reply.code(409).send({ error: "courier_profile_not_active" });
    if (outcome === "already_exists") return reply.code(409).send({ error: "courier_vehicle_already_exists" });
    return reply.code(201).send({ outcome, vehicleId, verificationStatus: "pending", active: false });
  });

  app.post<{ Params: { vehicleId: string }; Body: unknown }>("/api/v1/platform/courier-vehicles/:vehicleId/review", async (request, reply) => {
    const auth = await authorizeRequest(request, options, {
      resource: "platform.courier_profile", action: "approve", scope: { platform: true }
    });
    if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
    const roles = new Set([auth.actor.role, ...(auth.actor.roles ?? [])]);
    if (![...roles].some(role => role === "platform_owner" || role === "platform_admin")) return reply.code(403).send({ error: "platform_admin_only" });
    if (!options.courierAdminProfiles || !options.auditEvents) return reply.code(503).send({ error: "courier_admin_unavailable" });
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(request.params.vehicleId)) return reply.code(400).send({ error: "invalid_vehicle_id" });
    const body = request.body as Record<string, unknown> | null;
    if (!body || !["approve", "reject"].includes(String(body.decision)) || Object.keys(body).some(key => key !== "decision")) {
      return reply.code(400).send({ error: "invalid_vehicle_review" });
    }
    const decision = body.decision as "approve" | "reject";
    const outcome = await options.courierAdminProfiles.reviewVehicle({ vehicleId: request.params.vehicleId, decision, reviewerId: auth.actor.id });
    await options.auditEvents.append(createAuditEvent({
      id: randomUUID(), type: outcome === "updated" ? "courier_vehicle.reviewed" : "courier_vehicle.review_rejected",
      category: "courier_governance", occurredAt: new Date().toISOString(),
      actor: { id: auth.actor.id, type: "platform_user", role: auth.actor.role },
      action: `platform.courier_vehicle.${decision}`, outcome: outcome === "updated" ? "success" : "failure",
      resourceType: "courier_vehicle", resourceId: request.params.vehicleId,
      correlationId: request.id, source: "api", severity: "high", metadata: { decision }
    }));
    if (outcome === "not_found") return reply.code(404).send({ error: "courier_vehicle_not_found" });
    if (outcome === "invalid_transition") return reply.code(409).send({ error: "courier_vehicle_review_conflict" });
    return reply.code(200).send({ outcome, vehicleId: request.params.vehicleId, decision, active: decision === "approve" });
  });

  app.post<{ Body: unknown }>("/api/v1/platform/courier-service-area-memberships/grant", async (request, reply) => {
    const auth = await authorizeRequest(request, options, {
      resource: "platform.courier_profile", action: "manage_access", scope: { platform: true }
    });
    if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
    const roles = new Set([auth.actor.role, ...(auth.actor.roles ?? [])]);
    if (![...roles].some(role => role === "platform_owner" || role === "platform_admin")) return reply.code(403).send({ error: "platform_admin_only" });
    if (!options.courierAdminProfiles || !options.auditEvents) return reply.code(503).send({ error: "courier_admin_unavailable" });
    const body = request.body as Record<string, unknown> | null;
    const keys = ["courierId", "tenantId", "serviceAreaId"] as const;
    if (!body || keys.some(key => typeof body[key] !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(body[key] as string)) ||
        Object.keys(body).some(key => !keys.includes(key as typeof keys[number]))) return reply.code(400).send({ error: "invalid_courier_service_area_membership" });
    const input = { courierId: body.courierId as string, tenantId: body.tenantId as string, serviceAreaId: body.serviceAreaId as string };
    const outcome = await options.courierAdminProfiles.grantServiceArea({ ...input, reviewerId: auth.actor.id });
    await options.auditEvents.append(createAuditEvent({
      id: randomUUID(), type: outcome === "granted" ? "courier_service_area.granted" : "courier_service_area.grant_rejected",
      category: "courier_governance", occurredAt: new Date().toISOString(),
      actor: { id: auth.actor.id, type: "platform_user", role: auth.actor.role },
      action: "platform.courier_service_area.grant", outcome: outcome === "granted" ? "success" : "failure",
      resourceType: "courier_service_area_membership", resourceId: input.serviceAreaId, tenantId: input.tenantId,
      correlationId: request.id, source: "api", severity: "high", metadata: { courierId: input.courierId }
    }));
    if (outcome === "courier_not_found") return reply.code(404).send({ error: "courier_profile_not_found" });
    if (outcome === "courier_not_active") return reply.code(409).send({ error: "courier_profile_not_active" });
    if (outcome === "service_area_not_active") return reply.code(409).send({ error: "service_area_not_active" });
    return reply.code(201).send({ outcome, ...input, active: true });
  });

  app.post<{ Body: unknown }>("/api/v1/platform/courier-service-area-memberships/revoke", async (request, reply) => {
    const auth = await authorizeRequest(request, options, {
      resource: "platform.courier_profile", action: "manage_access", scope: { platform: true }
    });
    if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
    const roles = new Set([auth.actor.role, ...(auth.actor.roles ?? [])]);
    if (![...roles].some(role => role === "platform_owner" || role === "platform_admin")) return reply.code(403).send({ error: "platform_admin_only" });
    if (!options.courierAdminProfiles || !options.auditEvents) return reply.code(503).send({ error: "courier_admin_unavailable" });
    const body = request.body as Record<string, unknown> | null;
    const keys = ["courierId", "tenantId", "serviceAreaId"] as const;
    if (!body || keys.some(key => typeof body[key] !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(body[key] as string)) ||
        Object.keys(body).some(key => !keys.includes(key as typeof keys[number]))) return reply.code(400).send({ error: "invalid_courier_service_area_membership" });
    const input = { courierId: body.courierId as string, tenantId: body.tenantId as string, serviceAreaId: body.serviceAreaId as string };
    const outcome = await options.courierAdminProfiles.revokeServiceArea(input);
    await options.auditEvents.append(createAuditEvent({
      id: randomUUID(), type: outcome === "revoked" ? "courier_service_area.revoked" : "courier_service_area.revoke_not_found",
      category: "courier_governance", occurredAt: new Date().toISOString(),
      actor: { id: auth.actor.id, type: "platform_user", role: auth.actor.role },
      action: "platform.courier_service_area.revoke", outcome: outcome === "revoked" ? "success" : "failure",
      resourceType: "courier_service_area_membership", resourceId: input.serviceAreaId, tenantId: input.tenantId,
      correlationId: request.id, source: "api", severity: "high", metadata: { courierId: input.courierId }
    }));
    if (outcome === "not_found") return reply.code(404).send({ error: "courier_service_area_membership_not_found" });
    return reply.code(200).send({ outcome, ...input, active: false });
  });

  // Only platform administrators can authorize external inventory providers for a branch.
  app.post<{ Body: unknown }>(
    "/api/v1/platform/inventory-provider-capabilities/hard-reservation/approve",
    async (request, reply) => {
      const authorization = await authorizeRequest(request, options, {
        resource: "platform.inventory_provider_branch_scope", action: "manage_access", scope: { platform: true }
      });
      if (!authorization.actor) return sendAuthorizationFailure(reply, authorization.statusCode, authorization.decision.reason);
      const roles = new Set([authorization.actor.role, ...(authorization.actor.roles ?? [])]);
      if (![...roles].some(role => role === "platform_owner" || role === "platform_admin")) {
        return reply.code(403).send({ error: "platform_admin_only" });
      }
      if (!options.inventoryProviderBranchScopes || !options.auditEvents) {
        return reply.code(503).send({ error: "inventory_provider_scope_management_unavailable" });
      }
      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body.tenantId !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/.test(body.tenantId) ||
          typeof body.integrationId !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/.test(body.integrationId)) {
        return reply.code(400).send({ error: "invalid_inventory_provider_capability_request" });
      }
      const input = { tenantId: body.tenantId, integrationId: body.integrationId };
      const auditBase = {
        id: randomUUID(), category: "integration_governance", occurredAt: new Date().toISOString(),
        actor: { id: authorization.actor.id, type: "platform_user" as const, role: authorization.actor.role },
        action: "platform.inventory_provider_capability.hard_reservation.approve",
        resourceType: "tenant_integration", resourceId: input.integrationId, tenantId: input.tenantId,
        correlationId: request.id, source: "api", severity: "high" as const,
        metadata: { capability: "inventory.hard_reservation" }
      };
      await options.auditEvents.append(createAuditEvent({
        ...auditBase, type: "inventory_provider_capability.approval.requested", outcome: "pending"
      }));
      const outcome = await options.inventoryProviderBranchScopes.approveHardReservationCapability(input);
      await options.auditEvents.append(createAuditEvent({
        ...auditBase, id: randomUUID(),
        type: outcome === "approved" ? "inventory_provider_capability.approved" : "inventory_provider_capability.approval_rejected",
        outcome: outcome === "approved" ? "success" : "failure"
      }));
      if (outcome === "not_eligible") return reply.code(409).send({ error: "provider_not_connected_or_unsupported" });
      return reply.code(200).send({ outcome, integrationId: input.integrationId, capability: "inventory.hard_reservation" });
    }
  );

  app.post<{ Body: unknown }>(
    "/api/v1/platform/inventory-provider-branch-scopes/grant",
    async (request, reply) => {
      const authorization = await authorizeRequest(request, options, {
        resource: "platform.inventory_provider_branch_scope", action: "manage_access", scope: { platform: true }
      });
      if (!authorization.actor) return sendAuthorizationFailure(reply, authorization.statusCode, authorization.decision.reason);
      const roles = new Set([authorization.actor.role, ...(authorization.actor.roles ?? [])]);
      if (![...roles].some(role => role === "platform_owner" || role === "platform_admin")) {
        return reply.code(403).send({ error: "platform_admin_only" });
      }
      if (!options.inventoryProviderBranchScopes || !options.auditEvents) {
        return reply.code(503).send({ error: "inventory_provider_scope_management_unavailable" });
      }
      const body = request.body as Record<string, unknown> | null;
      const keys = ["tenantId", "integrationId", "merchantId", "branchId"] as const;
      if (!body || keys.some(key => typeof body[key] !== "string" ||
          !(body[key] as string).trim() || (body[key] as string).length > 160 ||
          !/^[a-zA-Z0-9._:-]+$/.test(body[key] as string))) {
        return reply.code(400).send({ error: "invalid_inventory_provider_scope" });
      }
      const input = { tenantId: body.tenantId as string, integrationId: body.integrationId as string,
        merchantId: body.merchantId as string, branchId: body.branchId as string };
      const auditBase = {
        id: randomUUID(), category: "integration_governance", occurredAt: new Date().toISOString(),
        actor: { id: authorization.actor.id, type: "platform_user" as const, role: authorization.actor.role },
        action: "platform.inventory_provider_branch_scope.grant",
        resourceType: "merchant_inventory_provider_branch_scope", resourceId: input.integrationId,
        tenantId: input.tenantId, merchantId: input.merchantId, branchId: input.branchId,
        correlationId: request.id, source: "api", severity: "high" as const,
        metadata: { integrationId: input.integrationId }
      };
      await options.auditEvents.append(createAuditEvent({
        ...auditBase, type: "inventory_provider_branch_scope.grant.requested", outcome: "pending"
      }));
      const outcome = await options.inventoryProviderBranchScopes.grant(input);
      await options.auditEvents.append(createAuditEvent({
        ...auditBase, id: randomUUID(),
        type: outcome === "granted" ? "inventory_provider_branch_scope.granted" : "inventory_provider_branch_scope.grant_rejected",
        outcome: outcome === "granted" ? "success" : "failure"
      }));
      if (outcome === "not_eligible") return reply.code(409).send({ error: "provider_or_branch_not_eligible" });
      return reply.code(201).send({ outcome, scope: input });
    }
  );

  app.post<{ Body: unknown }>(
    "/api/v1/platform/inventory-provider-branch-scopes/revoke",
    async (request, reply) => {
      const authorization = await authorizeRequest(request, options, {
        resource: "platform.inventory_provider_branch_scope", action: "manage_access", scope: { platform: true }
      });
      if (!authorization.actor) return sendAuthorizationFailure(reply, authorization.statusCode, authorization.decision.reason);
      const roles = new Set([authorization.actor.role, ...(authorization.actor.roles ?? [])]);
      if (![...roles].some(role => role === "platform_owner" || role === "platform_admin")) {
        return reply.code(403).send({ error: "platform_admin_only" });
      }
      if (!options.inventoryProviderBranchScopes || !options.auditEvents) {
        return reply.code(503).send({ error: "inventory_provider_scope_management_unavailable" });
      }
      const body = request.body as Record<string, unknown> | null;
      const keys = ["tenantId", "integrationId", "merchantId", "branchId"] as const;
      if (!body || keys.some(key => typeof body[key] !== "string" ||
          !(body[key] as string).trim() || (body[key] as string).length > 160 ||
          !/^[a-zA-Z0-9._:-]+$/.test(body[key] as string))) {
        return reply.code(400).send({ error: "invalid_inventory_provider_scope" });
      }
      const input = { tenantId: body.tenantId as string, integrationId: body.integrationId as string,
        merchantId: body.merchantId as string, branchId: body.branchId as string };
      const auditBase = {
        id: randomUUID(), category: "integration_governance", occurredAt: new Date().toISOString(),
        actor: { id: authorization.actor.id, type: "platform_user" as const, role: authorization.actor.role },
        action: "platform.inventory_provider_branch_scope.revoke",
        resourceType: "merchant_inventory_provider_branch_scope", resourceId: input.integrationId,
        tenantId: input.tenantId, merchantId: input.merchantId, branchId: input.branchId,
        correlationId: request.id, source: "api", severity: "high" as const,
        metadata: { integrationId: input.integrationId }
      };
      await options.auditEvents.append(createAuditEvent({
        ...auditBase, type: "inventory_provider_branch_scope.revoke.requested", outcome: "pending"
      }));
      const outcome = await options.inventoryProviderBranchScopes.revoke(input);
      await options.auditEvents.append(createAuditEvent({
        ...auditBase, id: randomUUID(),
        type: outcome === "revoked" ? "inventory_provider_branch_scope.revoked" : "inventory_provider_branch_scope.revoke_not_found",
        outcome: outcome === "revoked" ? "success" : "failure"
      }));
      if (outcome === "not_found") return reply.code(404).send({ error: "inventory_provider_scope_not_found" });
      return reply.code(200).send({ outcome, scope: input });
    }
  );


  app.get<{
    Params: { merchantId: string; branchId: string };
  }>("/api/v1/merchants/:merchantId/branches/:branchId/access-check", async (request, reply) => {
    const result = await authorizeRequest(request, options, {
      resource: "merchant.branch",
      action: "read",
      scope: {
        merchantId: request.params.merchantId,
        branchId: request.params.branchId
      }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    return reply.code(200).send({ access: "granted" });
  });

  app.post<{
    Params: { providerKey: string };
    Body: unknown;
  }>("/api/v1/webhooks/payouts/:providerKey", {
    bodyLimit: 65_536,
    preParsing: async (request, reply, payload) => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of payload) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (size > 65_536) {
          reply.code(413).send({ error: "webhook_payload_too_large" });
          return Readable.from([]);
        }
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks);
      merchantPayoutWebhookRawBodies.set(request, raw.toString("utf8"));
      return Readable.from([raw]);
    }
  }, async (request, reply) => {
    if (reply.sent) return reply;
    if (request.params.providerKey !== "moyasar") {
      return reply.code(404).send({ error: "payout_provider_not_supported" });
    }
    if (!options.merchantPayoutConfirmationWebhook) {
      return reply.code(503).send({ error: "payout_webhook_unavailable" });
    }
    const rawBody = merchantPayoutWebhookRawBodies.get(request);
    if (!rawBody) return reply.code(400).send({ error: "empty_webhook_body" });

    const headerValue = (value: string | string[] | undefined): string | undefined =>
      value === undefined ? undefined : Array.isArray(value) ? value.join(",") : value;
    const eventId = headerValue(request.headers["x-event-id"]);
    const eventType = headerValue(request.headers["x-event-type"]);
    const eventSecret = headerValue(request.headers["x-event-secret"]);
    const headers: Record<string, string> = {};
    if (eventId !== undefined) headers["x-event-id"] = eventId;
    if (eventType !== undefined) headers["x-event-type"] = eventType;
    if (eventSecret !== undefined) headers["x-event-secret"] = eventSecret;

    let result: Awaited<ReturnType<MerchantPayoutConfirmationWebhookHandler["process"]>>;
    try {
      result = await options.merchantPayoutConfirmationWebhook.process({ rawBody, headers });
    } catch {
      return reply.code(500).send({ error: "payout_webhook_processing_failed" });
    }
    if (result.outcome === "provider_not_configured") {
      return reply.code(503).send({ error: "webhook_provider_not_configured" });
    }
    if (result.outcome === "invalid_signature_or_event") {
      return reply.code(401).send({ error: "invalid_webhook_secret_or_event" });
    }
    return reply.code(200).send(result);
  });

  app.post<{
    Params: { providerKey: string };
    Body: unknown;
  }>("/api/v1/webhooks/payouts/:providerKey/exceptions", {
    bodyLimit: 65_536,
    preParsing: async (request, reply, payload) => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of payload) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (size > 65_536) {
          reply.code(413).send({ error: "webhook_payload_too_large" });
          return Readable.from([]);
        }
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks);
      merchantPayoutWebhookRawBodies.set(request, raw.toString("utf8"));
      return Readable.from([raw]);
    }
  }, async (request, reply) => {
    if (reply.sent) return reply;
    if (request.params.providerKey !== "moyasar") return reply.code(404).send({ error: "payout_provider_not_supported" });
    if (!options.merchantPayoutExceptionWebhook) return reply.code(503).send({ error: "payout_exception_webhook_unavailable" });
    const rawBody = merchantPayoutWebhookRawBodies.get(request);
    if (!rawBody) return reply.code(400).send({ error: "empty_webhook_body" });
    const headerValue = (value: string | string[] | undefined): string | undefined =>
      value === undefined ? undefined : Array.isArray(value) ? value.join(",") : value;
    const headers: Record<string, string> = {};
    const eventId = headerValue(request.headers["x-event-id"]);
    const eventType = headerValue(request.headers["x-event-type"]);
    const eventSecret = headerValue(request.headers["x-event-secret"]);
    if (eventId !== undefined) headers["x-event-id"] = eventId;
    if (eventType !== undefined) headers["x-event-type"] = eventType;
    if (eventSecret !== undefined) headers["x-event-secret"] = eventSecret;
    let result: Awaited<ReturnType<MerchantPayoutExceptionWebhookHandler["process"]>>;
    try { result = await options.merchantPayoutExceptionWebhook.process({ rawBody, headers }); }
    catch { return reply.code(500).send({ error: "payout_exception_processing_failed" }); }
    if (result.outcome === "provider_not_configured") return reply.code(503).send({ error: "webhook_provider_not_configured" });
    if (result.outcome === "invalid_signature_or_event") return reply.code(401).send({ error: "invalid_webhook_secret_or_event" });
    return reply.code(200).send(result);
  });

  app.post<{
    Params: { providerKey: string };
    Body: unknown;
  }>("/api/v1/webhooks/payments/:providerKey", {
    bodyLimit: 65_536,
    preParsing: async (request, reply, payload) => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of payload) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (size > 65_536) {
          reply.code(413).send({ error: "webhook_payload_too_large" });
          return Readable.from([]);
        }
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks);
      paymentWebhookRawBodies.set(request, raw.toString("utf8"));
      return Readable.from([raw]);
    }
  }, async (request, reply) => {
    if (reply.sent) return reply;
    const { providerKey } = request.params;
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(providerKey)) {
      return reply.code(400).send({ error: "invalid_provider" });
    }
    const rawBody = paymentWebhookRawBodies.get(request);
    if (rawBody === undefined || !rawBody.length) {
      return reply.code(400).send({ error: "empty_webhook_body" });
    }
    const signatureHeader = request.headers["x-payment-signature"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    const body = request.body;
    if (typeof body !== "object" || body === null ||
        typeof (body as { id?: unknown }).id !== "string" ||
        !/^[a-zA-Z0-9._:-]{1,240}$/.test((body as { id: string }).id) ||
        (body as { id: string }).id.length > 240) {
      return reply.code(400).send({ error: "invalid_webhook_event" });
    }
    const eventType = (body as { type?: unknown }).type;
    if (providerKey === "moyasar" && eventType === "payment_refunded") {
      if (!options.paymentRefundWebhookHandler) {
        return reply.code(503).send({ error: "payment_refund_processor_unavailable" });
      }
      const result = await options.paymentRefundWebhookHandler.process({ providerKey, rawBody });
      if (result.outcome === "invalid_signature_or_event") {
        return reply.code(401).send({ error: "invalid_webhook_signature_or_refund_event" });
      }
      if (result.outcome === "provider_not_configured") {
        return reply.code(503).send({ error: "webhook_provider_not_configured" });
      }
      if (result.outcome === "event_id_collision") {
        return reply.code(409).send({ error: "provider_event_id_collision" });
      }
      return reply.code(result.outcome === "reconciliation_required" ? 202 : 200).send(result);
    }
    if (eventType === "payment.captured" || (providerKey === "moyasar" && (eventType === "payment_paid" || eventType === "payment_captured"))) {
      if (!options.paymentCaptureWebhookHandler) {
        return reply.code(503).send({ error: "payment_capture_processor_unavailable" });
      }
      const result = await options.paymentCaptureWebhookHandler.process({
        providerKey, rawBody, ...(signature === undefined ? {} : { signatureHeader: signature })
      });
      if (result.outcome === "invalid_signature_or_event") {
        return reply.code(401).send({ error: "invalid_webhook_signature_or_capture_event" });
      }
      if (result.outcome === "provider_not_configured") {
        return reply.code(503).send({ error: "webhook_provider_not_configured" });
      }
      if (result.outcome === "payment_intent_not_found") {
        return reply.code(404).send({ error: "payment_intent_not_found" });
      }
      if (result.outcome === "identity_collision") {
        return reply.code(409).send({ error: "provider_payment_identity_collision" });
      }
      return reply.code(result.outcome === "recorded" ? 201 : 200).send(result);
    }
    if (!options.paymentWebhookInbox || !options.paymentWebhookSecretResolver) {
      return reply.code(503).send({ error: "webhook_service_unavailable" });
    }
    const secret = await options.paymentWebhookSecretResolver(providerKey);
    if (!secret) return reply.code(503).send({ error: "webhook_provider_not_configured" });
    if (!verifyPaymentProviderWebhook({ rawBody, signatureHeader: signature, secret })) {
      return reply.code(401).send({ error: "invalid_webhook_signature" });
    }
    const normalizedStatus = (body as { status?: unknown }).status;
    const adjustmentId = (body as { adjustmentId?: unknown }).adjustmentId;
    const providerReference = (body as { providerReference?: unknown }).providerReference;
    if (typeof eventType !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/.test(eventType) ||
        typeof normalizedStatus !== "string" ||
        !["succeeded", "failed", "ignored", "unsupported"].includes(normalizedStatus) ||
        (adjustmentId !== undefined && (typeof adjustmentId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(adjustmentId))) ||
        (providerReference !== undefined && (typeof providerReference !== "string" || !providerReference.trim() || providerReference.length > 240)) ||
        (normalizedStatus === "succeeded" && (typeof adjustmentId !== "string" || typeof providerReference !== "string"))) {
      return reply.code(400).send({ error: "invalid_webhook_event" });
    }
    const receipt = await options.paymentWebhookInbox.record({
      providerKey,
      providerEventId: (body as { id: string }).id,
      rawBody,
      eventType,
      normalizedStatus: normalizedStatus as "succeeded" | "failed" | "ignored" | "unsupported",
      ...(typeof adjustmentId === "string" ? { adjustmentId } : {}),
      ...(typeof providerReference === "string" ? { providerReference } : {})
    });
    if (receipt.outcome === "event_id_collision") {
      return reply.code(409).send({ error: "provider_event_id_collision" });
    }
    return reply.code(202).send({
      outcome: receipt.outcome,
      receiptId: receipt.receiptId
    });
  });

  app.post<{ Params: { providerKey: string }; Body: unknown }>(
    "/api/v1/webhooks/fulfillment/:providerKey",
    {
      bodyLimit: 65_536,
      preParsing: async (request, reply, payload) => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of payload) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          size += buffer.length;
          if (size > 65_536) {
            reply.code(413).send({ error: "webhook_payload_too_large" });
            return Readable.from([]);
          }
          chunks.push(buffer);
        }
        const raw = Buffer.concat(chunks);
        fulfillmentWebhookRawBodies.set(request, raw.toString("utf8"));
        return Readable.from([raw]);
      }
    },
    async (request, reply) => {
      if (reply.sent) return reply;
      const { providerKey } = request.params;
      if (!/^[a-zA-Z0-9._-]{1,100}$/.test(providerKey)) {
        return reply.code(400).send({ error: "invalid_provider" });
      }
      if (!options.fulfillmentHandoverInbox || !options.fulfillmentWebhookSecretResolver ||
          !options.fulfillmentWebhookAuthorizationResolver) {
        return reply.code(503).send({ error: "webhook_service_unavailable" });
      }
      const rawBody = fulfillmentWebhookRawBodies.get(request);
      if (!rawBody) return reply.code(400).send({ error: "empty_webhook_body" });
      const header = request.headers["x-fulfillment-signature"];
      const signature = Array.isArray(header) ? header[0] : header;
      const secret = await options.fulfillmentWebhookSecretResolver(providerKey);
      if (!secret) return reply.code(503).send({ error: "webhook_provider_not_configured" });
      const event = verifyAndParseFulfillmentHandoverEvent({
        providerKey, rawBody, signatureHeader: signature, secret
      });
      if (!event) return reply.code(401).send({ error: "invalid_webhook_signature_or_event" });
      let authorized = false;
      try {
        authorized = await options.fulfillmentWebhookAuthorizationResolver(providerKey, event);
      } catch {
        authorized = false;
      }
      if (!authorized) return reply.code(403).send({ error: "fulfillment_provider_scope_not_authorized" });
      const result = await options.fulfillmentHandoverInbox.recordAndApply({
        event, rawBody, nowUtc: new Date().toISOString()
      });
      if (result.outcome === "event_id_collision") {
        return reply.code(409).send({ error: "provider_event_id_collision" });
      }
      if (result.outcome === "reservation_not_found") {
        return reply.code(404).send({ error: "reservation_not_found" });
      }
      if (result.outcome === "reservation_expired" ||
          result.outcome === "reservation_already_finalized") {
        return reply.code(409).send(result);
      }
      return reply.code(result.outcome === "applied" ? 200 : 202).send(result);
    }
  );

  app.post<{
    Params: { batchId: string };
  }>("/api/v1/platform/settlements/:batchId/approval-requests", async (request, reply) => {
    const access = await authorizeRequest(request, options, {
      resource: "platform.merchant_settlement", action: "create", scope: { platform: true }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    const roles = access.actor.roles ?? [access.actor.role];
    const requesterRole = roles.find((role): role is SettlementApprovalRole =>
      role === "operations" || role === "finance" || role === "platform_admin" || role === "platform_owner");
    if (!requesterRole) return reply.code(403).send({ error: "platform_settlement_request_role_required" });
    if (!options.merchantSettlementApprovals) return reply.code(503).send({ error: "settlement_approval_unavailable" });
    const result = await options.merchantSettlementApprovals.request({
      batchId: request.params.batchId, requesterId: access.actor.id, requesterRole
    });
    if (result.outcome === "not_found") return reply.code(404).send({ error: "settlement_batch_not_found" });
    if (result.outcome === "already_pending") return reply.code(409).send({ error: "settlement_approval_already_pending" });
    if (result.outcome === "invalid_batch_state") return reply.code(409).send({ error: "settlement_batch_not_draft" });
    if (result.outcome === "empty_or_unbalanced_batch") return reply.code(409).send({ error: "settlement_batch_not_ready_for_review" });
    if (!("request" in result)) return reply.code(409).send({ error: "settlement_approval_request_not_created" });
    return reply.code(201).send({ request: result.request });
  });

  app.get<{
    Querystring: { limit?: string };
  }>("/api/v1/platform/settlement-approval-requests", async (request, reply) => {
    const access = await authorizeRequest(request, options, {
      resource: "platform.merchant_settlement", action: "read", scope: { platform: true }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    const roles = access.actor.roles ?? [access.actor.role];
    if (!roles.some(role => role === "finance" || role === "platform_admin" || role === "platform_owner")) {
      return reply.code(403).send({ error: "platform_settlement_reviewer_role_required" });
    }
    if (!options.merchantSettlementApprovals) return reply.code(503).send({ error: "settlement_approval_unavailable" });
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return reply.code(400).send({ error: "invalid_limit" });
    }
    const requests = await options.merchantSettlementApprovals.listPending({ limit });
    return reply.code(200).send({ requests });
  });

  app.post<{
    Params: { requestId: string };
    Body: { decision?: string; reason?: string };
  }>("/api/v1/platform/settlement-approval-requests/:requestId/decision", async (request, reply) => {
    const access = await authorizeRequest(request, options, {
      resource: "platform.merchant_settlement", action: "approve", scope: { platform: true }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    const roles = access.actor.roles ?? [access.actor.role];
    const actorRole = roles.find((role): role is "finance" | "platform_admin" | "platform_owner" =>
      role === "finance" || role === "platform_admin" || role === "platform_owner");
    if (!actorRole) return reply.code(403).send({ error: "platform_settlement_approver_role_required" });
    const body = request.body;
    if (!body || (body.decision !== "authorize_accounting" && body.decision !== "reject") ||
        (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 1000))) {
      return reply.code(400).send({ error: "invalid_settlement_approval_decision" });
    }
    if (!options.merchantSettlementApprovals) return reply.code(503).send({ error: "settlement_approval_unavailable" });
    const result = await options.merchantSettlementApprovals.decide({
      requestId: request.params.requestId, actorId: access.actor.id, actorRole,
      decision: body.decision, ...(body.reason === undefined ? {} : { reason: body.reason })
    });
    if (result.outcome === "not_found") return reply.code(404).send({ error: "settlement_approval_request_not_found" });
    if (result.outcome === "self_approval") return reply.code(403).send({ error: "settlement_requester_cannot_approve" });
    if (result.outcome === "already_decided") return reply.code(409).send({ error: "settlement_approval_already_decided" });
    if (result.outcome === "snapshot_changed") return reply.code(409).send({ error: "settlement_snapshot_changed" });
    if (result.outcome === "invalid_transition") return reply.code(409).send({ error: "settlement_approval_transition_invalid" });
    if (!("request" in result)) return reply.code(409).send({ error: "settlement_approval_decision_not_recorded" });
    return reply.code(200).send({ request: result.request });
  });

  app.post<{
    Params: { batchId: string };
  }>("/api/v1/platform/settlements/:batchId/accounting-posting", async (request, reply) => {
    const access = await authorizeRequest(request, options, {
      resource: "platform.merchant_settlement", action: "approve", scope: { platform: true }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    const roles = access.actor.roles ?? [access.actor.role];
    const actorRole = roles.find((role): role is SettlementAccountingActorRole =>
      role === "finance" || role === "platform_admin" || role === "platform_owner");
    if (!actorRole) return reply.code(403).send({ error: "platform_settlement_accounting_role_required" });
    if (!options.merchantSettlementAccountingPoster) {
      return reply.code(503).send({ error: "settlement_accounting_poster_unavailable" });
    }
    const result = await options.merchantSettlementAccountingPoster.post({
      batchId: request.params.batchId, actorId: access.actor.id, actorRole
    });
    if (result.outcome === "not_found") return reply.code(404).send({ error: "settlement_batch_not_found" });
    if (result.outcome === "not_authorized") return reply.code(403).send({ error: "settlement_accounting_authorization_required" });
    if (result.outcome === "not_ready") return reply.code(409).send({ error: result.reason });
    return reply.code(200).send({ outcome: "accounting_posted", journalId: result.journalId,
      payoutInitiated: false });
  });

  app.get<{ Querystring: { tenantId?: string; limit?: string } }>(
    "/api/v1/platform/payout-provider-entities", async (request, reply) => {
      const access = await authorizeRequest(request, options, {
        resource: "platform.merchant_payout_provider_entity", action: "read", scope: { platform: true }
      });
      if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
      const roles = access.actor.roles ?? [access.actor.role];
      if (!roles.some(role => role === "platform_admin" || role === "platform_owner")) {
        return reply.code(403).send({ error: "platform_payout_provider_admin_role_required" });
      }
      if (!options.merchantPayoutProviderEntities) return reply.code(503).send({ error: "payout_provider_entity_registry_unavailable" });
      const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200 ||
          (request.query.tenantId !== undefined && !/^[A-Za-z0-9._:-]{1,160}$/.test(request.query.tenantId))) {
        return reply.code(400).send({ error: "invalid_payout_provider_entity_query" });
      }
      const entities = await options.merchantPayoutProviderEntities.list({
        ...(request.query.tenantId === undefined ? {} : { tenantId: request.query.tenantId }), limit
      });
      return reply.code(200).send({ entities });
    }
  );

  app.post<{ Body: unknown }>("/api/v1/platform/payout-provider-entities", async (request, reply) => {
    const access = await authorizeRequest(request, options, {
      resource: "platform.merchant_payout_provider_entity", action: "create", scope: { platform: true }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    const roles = access.actor.roles ?? [access.actor.role];
    if (!roles.some(role => role === "platform_admin" || role === "platform_owner")) {
      return reply.code(403).send({ error: "platform_payout_provider_admin_role_required" });
    }
    if (!options.merchantPayoutProviderEntities || !options.auditEvents) {
      return reply.code(503).send({ error: "payout_provider_entity_registry_unavailable" });
    }
    const body = request.body as Record<string, unknown> | null;
    const keys = ["tenantId", "merchantId", "providerKey", "providerMerchantId", "providerEntityId"];
    if (!body || keys.some(key => typeof body[key] !== "string" ||
        !/^[A-Za-z0-9._:-]{1,240}$/.test(body[key] as string)) ||
        body.providerKey !== "moyasar" || Object.keys(body).some(key => !keys.includes(key))) {
      return reply.code(400).send({ error: "invalid_payout_provider_entity" });
    }
    const input = {
      tenantId: body.tenantId as string, merchantId: body.merchantId as string,
      providerKey: "moyasar", providerMerchantId: body.providerMerchantId as string,
      providerEntityId: body.providerEntityId as string
    };
    const auditBase = {
      id: randomUUID(), category: "payout_governance", occurredAt: new Date().toISOString(),
      actor: { id: access.actor.id, type: "platform_user" as const, role: access.actor.role },
      action: "platform.payout_provider_entity.register", resourceType: "payout_provider_entity",
      resourceId: input.merchantId, tenantId: input.tenantId, merchantId: input.merchantId,
      correlationId: request.id, source: "api", severity: "critical" as const,
      metadata: { providerKey: input.providerKey }
    };
    await options.auditEvents.append(createAuditEvent({
      ...auditBase, type: "payout_provider_entity.registration_requested", outcome: "pending"
    }));
    const result = await options.merchantPayoutProviderEntities.register({ ...input, actorId: access.actor.id });
    await options.auditEvents.append(createAuditEvent({
      ...auditBase, id: randomUUID(),
      type: result.outcome === "created" ? "payout_provider_entity.registered" : "payout_provider_entity.registration_rejected",
      outcome: result.outcome === "created" ? "success" : "failure",
      ...(result.outcome === "created" ? { resourceId: result.entity.id } : {})
    }));
    if (result.outcome !== "created") {
      if (result.outcome === "merchant_not_found") return reply.code(404).send({ error: "active_merchant_not_found_in_tenant" });
      return reply.code(409).send({ error: "payout_provider_entity_identity_conflict" });
    }
    return reply.code(201).send({ entity: result.entity, transfersEnabled: false });
  });

  app.post<{ Params: { entityId: string } }>(
    "/api/v1/platform/payout-provider-entities/:entityId/revoke", async (request, reply) => {
      const access = await authorizeRequest(request, options, {
        resource: "platform.merchant_payout_provider_entity", action: "manage_access", scope: { platform: true }
      });
      if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
      const roles = access.actor.roles ?? [access.actor.role];
      if (!roles.some(role => role === "platform_admin" || role === "platform_owner")) {
        return reply.code(403).send({ error: "platform_payout_provider_admin_role_required" });
      }
      if (!options.merchantPayoutProviderEntities || !options.auditEvents) {
        return reply.code(503).send({ error: "payout_provider_entity_registry_unavailable" });
      }
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(request.params.entityId)) {
        return reply.code(400).send({ error: "invalid_payout_provider_entity_id" });
      }
      const auditBase = {
        id: randomUUID(), category: "payout_governance", occurredAt: new Date().toISOString(),
        actor: { id: access.actor.id, type: "platform_user" as const, role: access.actor.role },
        action: "platform.payout_provider_entity.revoke", resourceType: "payout_provider_entity",
        resourceId: request.params.entityId, correlationId: request.id, source: "api",
        severity: "critical" as const, metadata: {}
      };
      await options.auditEvents.append(createAuditEvent({
        ...auditBase, type: "payout_provider_entity.revocation_requested", outcome: "pending"
      }));
      const result = await options.merchantPayoutProviderEntities.revoke({
        entityId: request.params.entityId, actorId: access.actor.id
      });
      await options.auditEvents.append(createAuditEvent({
        ...auditBase, id: randomUUID(),
        type: result.outcome === "revoked" ? "payout_provider_entity.revoked" : "payout_provider_entity.revocation_rejected",
        outcome: result.outcome === "revoked" ? "success" : "failure"
      }));
      if (result.outcome === "not_found") return reply.code(404).send({ error: "payout_provider_entity_not_found" });
      if (result.outcome === "already_revoked") return reply.code(409).send({ error: "payout_provider_entity_already_revoked" });
      return reply.code(200).send({ outcome: "revoked", entityId: request.params.entityId, transfersEnabled: false });
    }
  );

  app.get<{Querystring:{status?:string;limit?:string}}>(
    "/api/v1/platform/payout-exception-cases",async(request,reply)=>{
      const access=await authorizeRequest(request,options,{resource:"platform.merchant_payout_exception_case",action:"read",scope:{platform:true}});
      if(!access.actor) return sendAuthorizationFailure(reply,access.statusCode,access.decision.reason);
      const roles=access.actor.roles??[access.actor.role];
      if(!roles.some(role=>role==="finance"||role==="platform_admin"||role==="platform_owner"))
        return reply.code(403).send({error:"payout_exception_reviewer_role_required"});
      if(!options.merchantPayoutExceptionCases) return reply.code(503).send({error:"payout_exception_case_store_unavailable"});
      const limit=request.query.limit===undefined?100:Number(request.query.limit);
      const status=request.query.status;
      if(!Number.isInteger(limit)||limit<1||limit>200||
        (status!==undefined&&!["open","under_review","resolved"].includes(status)))
        return reply.code(400).send({error:"invalid_payout_exception_query"});
      const cases=await options.merchantPayoutExceptionCases.list({
        ...(status===undefined?{}:{status:status as "open"|"under_review"|"resolved"}),limit
      });
      return reply.code(200).send({cases});
    }
  );

  app.post<{Params:{caseId:string}}>("/api/v1/platform/payout-exception-cases/:caseId/review",async(request,reply)=>{
    const access=await authorizeRequest(request,options,{resource:"platform.merchant_payout_exception_case",action:"approve",scope:{platform:true}});
    if(!access.actor) return sendAuthorizationFailure(reply,access.statusCode,access.decision.reason);
    const roles=access.actor.roles??[access.actor.role];
    if(!roles.some(role=>role==="finance"||role==="platform_admin"||role==="platform_owner"))
      return reply.code(403).send({error:"payout_exception_reviewer_role_required"});
    if(!options.merchantPayoutExceptionCases||!options.auditEvents)
      return reply.code(503).send({error:"payout_exception_case_store_unavailable"});
    if(!/^[A-Za-z0-9._:-]{1,160}$/.test(request.params.caseId))
      return reply.code(400).send({error:"invalid_payout_exception_case_id"});
    const base={id:randomUUID(),category:"payout_governance" as const,occurredAt:new Date().toISOString(),
      actor:{id:access.actor.id,type:"platform_user" as const,role:access.actor.role},
      action:"platform.payout_exception.review",resourceType:"merchant_payout_exception_case",
      resourceId:request.params.caseId,correlationId:request.id,source:"api",severity:"critical" as const,
      metadata:{caseId:request.params.caseId}};
    await options.auditEvents.append(createAuditEvent({...base,type:"payout_exception.review_requested",outcome:"pending"}));
    const result=await options.merchantPayoutExceptionCases.startReview({caseId:request.params.caseId,actorId:access.actor.id});
    await options.auditEvents.append(createAuditEvent({...base,id:randomUUID(),
      type:result.outcome==="started"?"payout_exception.review_started":"payout_exception.review_rejected",
      outcome:result.outcome==="started"?"success":"failure",metadata:{caseId:request.params.caseId,reason:result.outcome}}));
    if(result.outcome==="not_found") return reply.code(404).send({error:"payout_exception_case_not_found"});
    if(result.outcome==="not_open") return reply.code(409).send({error:"payout_exception_case_not_open"});
    return reply.code(200).send({case:result.case});
  });

  app.post<{Params:{caseId:string};Body:unknown}>("/api/v1/platform/payout-exception-cases/:caseId/resolve",async(request,reply)=>{
    const access=await authorizeRequest(request,options,{resource:"platform.merchant_payout_exception_case",action:"approve",scope:{platform:true}});
    if(!access.actor) return sendAuthorizationFailure(reply,access.statusCode,access.decision.reason);
    const roles=access.actor.roles??[access.actor.role];
    if(!roles.some(role=>role==="finance"||role==="platform_admin"||role==="platform_owner"))
      return reply.code(403).send({error:"payout_exception_reviewer_role_required"});
    if(!options.merchantPayoutExceptionCases||!options.auditEvents)
      return reply.code(503).send({error:"payout_exception_case_store_unavailable"});
    if(!/^[A-Za-z0-9._:-]{1,160}$/.test(request.params.caseId))
      return reply.code(400).send({error:"invalid_payout_exception_case_id"});
    const body=request.body as Record<string,unknown>|null;
    if(!body||Object.keys(body).some(key=>!["resolutionCode","resolutionNote"].includes(key))||
      typeof body.resolutionCode!=="string"||!/^[A-Z0-9_.:-]{1,100}$/.test(body.resolutionCode)||
      (body.resolutionNote!==undefined&&(typeof body.resolutionNote!=="string"||body.resolutionNote.length>2000)))
      return reply.code(400).send({error:"invalid_payout_exception_resolution"});
    const base={id:randomUUID(),category:"payout_governance" as const,occurredAt:new Date().toISOString(),
      actor:{id:access.actor.id,type:"platform_user" as const,role:access.actor.role},
      action:"platform.payout_exception.resolve",resourceType:"merchant_payout_exception_case",
      resourceId:request.params.caseId,correlationId:request.id,source:"api",severity:"critical" as const,
      metadata:{caseId:request.params.caseId,resolutionCode:body.resolutionCode}};
    await options.auditEvents.append(createAuditEvent({...base,type:"payout_exception.resolution_requested",outcome:"pending"}));
    const result=await options.merchantPayoutExceptionCases.resolve({
      caseId:request.params.caseId,actorId:access.actor.id,resolutionCode:body.resolutionCode,
      ...(typeof body.resolutionNote==="string"?{resolutionNote:body.resolutionNote}:{})
    });
    await options.auditEvents.append(createAuditEvent({...base,id:randomUUID(),
      type:result.outcome==="resolved"?"payout_exception.resolved":"payout_exception.resolution_rejected",
      outcome:result.outcome==="resolved"?"success":"failure",metadata:{caseId:request.params.caseId,
        resolutionCode:body.resolutionCode,reason:result.outcome}}));
    if(result.outcome==="not_found") return reply.code(404).send({error:"payout_exception_case_not_found"});
    if(result.outcome==="not_under_review") return reply.code(409).send({error:"payout_exception_case_not_under_review"});
    if(result.outcome==="reviewer_cannot_resolve") return reply.code(409).send({error:"payout_exception_independent_reviewer_required"});
    return reply.code(200).send({case:result.case,accountingReversalPosted:false});
  });

  app.get<{ Querystring:{tenantId?:string;merchantId?:string;limit?:string} }>(
    "/api/v1/platform/payout-destinations", async(request,reply)=>{
      const access=await authorizeRequest(request,options,{resource:"platform.merchant_payout_destination",action:"read",scope:{platform:true}});
      if(!access.actor) return sendAuthorizationFailure(reply,access.statusCode,access.decision.reason);
      const roles=access.actor.roles??[access.actor.role];
      if(!roles.some(role=>role==="platform_admin"||role==="platform_owner"||role==="finance"))
        return reply.code(403).send({error:"platform_payout_destination_admin_role_required"});
      if(!options.merchantPayoutDestinations) return reply.code(503).send({error:"payout_destination_registry_unavailable"});
      const limit=request.query.limit===undefined?100:Number(request.query.limit);
      if(!Number.isInteger(limit)||limit<1||limit>200||
        (request.query.tenantId!==undefined&&!/^[A-Za-z0-9._:-]{1,160}$/.test(request.query.tenantId))||
        (request.query.merchantId!==undefined&&!/^[A-Za-z0-9._:-]{1,160}$/.test(request.query.merchantId)))
        return reply.code(400).send({error:"invalid_payout_destination_query"});
      const destinations=await options.merchantPayoutDestinations.list({
        ...(request.query.tenantId===undefined?{}:{tenantId:request.query.tenantId}),
        ...(request.query.merchantId===undefined?{}:{merchantId:request.query.merchantId}),limit
      });
      return reply.code(200).send({destinations});
    }
  );

  app.post<{Body:unknown}>("/api/v1/platform/payout-destinations",async(request,reply)=>{
    const access=await authorizeRequest(request,options,{resource:"platform.merchant_payout_destination",action:"create",scope:{platform:true}});
    if(!access.actor) return sendAuthorizationFailure(reply,access.statusCode,access.decision.reason);
    const roles=access.actor.roles??[access.actor.role];
    if(!roles.some(role=>role==="platform_admin"||role==="platform_owner"))
      return reply.code(403).send({error:"platform_payout_destination_admin_role_required"});
    if(!options.merchantPayoutDestinations||!options.auditEvents)
      return reply.code(503).send({error:"payout_destination_registry_unavailable"});
    const body=request.body as Record<string,unknown>|null;
    const keys=["tenantId","merchantId","providerKey","currency","providerEntityRegistryId","vaultReference"];
    if(!body||Object.keys(body).some(key=>!keys.includes(key))||
      keys.some(key=>typeof body[key]!=="string")||body.providerKey!=="moyasar"||
      !/^[A-Z]{3}$/.test(body.currency as string)||
      (body.vaultReference as string).trim().length<8||(body.vaultReference as string).length>500)
      return reply.code(400).send({error:"invalid_payout_destination"});
    const input={tenantId:body.tenantId as string,merchantId:body.merchantId as string,
      providerKey:"moyasar",currency:body.currency as string,
      providerEntityRegistryId:body.providerEntityRegistryId as string,
      vaultReference:body.vaultReference as string};
    const base={id:randomUUID(),category:"payout_governance",occurredAt:new Date().toISOString(),
      actor:{id:access.actor.id,type:"platform_user" as const,role:access.actor.role},
      action:"platform.payout_destination.register",resourceType:"merchant_payout_destination",
      resourceId:input.merchantId,tenantId:input.tenantId,merchantId:input.merchantId,
      correlationId:request.id,source:"api",severity:"critical" as const,
      metadata:{providerKey:input.providerKey,currency:input.currency,providerEntityRegistryId:input.providerEntityRegistryId}};
    await options.auditEvents.append(createAuditEvent({...base,type:"payout_destination.registration_requested",outcome:"pending"}));
    const result=await options.merchantPayoutDestinations.register({...input,actorId:access.actor.id});
    await options.auditEvents.append(createAuditEvent({...base,id:randomUUID(),
      type:result.outcome==="created"?"payout_destination.registered":"payout_destination.registration_rejected",
      outcome:result.outcome==="created"?"success":"failure"}));
    if(result.outcome!=="created") {
      if(result.outcome==="provider_entity_not_found") return reply.code(409).send({error:"active_provider_entity_required"});
      return reply.code(409).send({error:"payout_destination_duplicate"});
    }
    return reply.code(201).send({destination:result.destination});
  });

  app.post<{Params:{destinationId:string}}>("/api/v1/platform/payout-destinations/:destinationId/verify",async(request,reply)=>{
    const access=await authorizeRequest(request,options,{resource:"platform.merchant_payout_destination",action:"approve",scope:{platform:true}});
    if(!access.actor) return sendAuthorizationFailure(reply,access.statusCode,access.decision.reason);
    const roles=access.actor.roles??[access.actor.role];
    if(!roles.some(role=>role==="finance"||role==="platform_admin"||role==="platform_owner"))
      return reply.code(403).send({error:"platform_payout_destination_reviewer_role_required"});
    if(!options.merchantPayoutDestinations||!options.auditEvents)
      return reply.code(503).send({error:"payout_destination_registry_unavailable"});
    if(!/^[A-Za-z0-9._:-]{1,160}$/.test(request.params.destinationId))
      return reply.code(400).send({error:"invalid_payout_destination_id"});
    const result=await options.merchantPayoutDestinations.verify({destinationId:request.params.destinationId,actorId:access.actor.id});
    await options.auditEvents.append(createAuditEvent({id:randomUUID(),category:"payout_governance",
      occurredAt:new Date().toISOString(),actor:{id:access.actor.id,type:"platform_user",role:access.actor.role},
      action:"platform.payout_destination.verify",resourceType:"merchant_payout_destination",
      resourceId:request.params.destinationId,correlationId:request.id,source:"api",severity:"critical",
      type:result.outcome==="verified"?"payout_destination.verified":"payout_destination.verification_rejected",
      outcome:result.outcome==="verified"?"success":"failure",metadata:{reason:result.outcome}}));
    if(result.outcome!=="verified") {
      if(result.outcome==="not_found") return reply.code(404).send({error:"payout_destination_not_found"});
      if(result.outcome==="self_approval") return reply.code(409).send({error:"payout_destination_self_approval_forbidden"});
      if(result.outcome==="not_pending") return reply.code(409).send({error:"payout_destination_not_pending"});
      return reply.code(409).send({error:"active_provider_entity_required"});
    }
    return reply.code(200).send({destination:result.destination});
  });

  app.post<{Params:{destinationId:string}}>("/api/v1/platform/payout-destinations/:destinationId/revoke",async(request,reply)=>{
    const access=await authorizeRequest(request,options,{resource:"platform.merchant_payout_destination",action:"manage_access",scope:{platform:true}});
    if(!access.actor) return sendAuthorizationFailure(reply,access.statusCode,access.decision.reason);
    const roles=access.actor.roles??[access.actor.role];
    if(!roles.some(role=>role==="platform_admin"||role==="platform_owner"))
      return reply.code(403).send({error:"platform_payout_destination_admin_role_required"});
    if(!options.merchantPayoutDestinations||!options.auditEvents)
      return reply.code(503).send({error:"payout_destination_registry_unavailable"});
    if(!/^[A-Za-z0-9._:-]{1,160}$/.test(request.params.destinationId))
      return reply.code(400).send({error:"invalid_payout_destination_id"});
    const result=await options.merchantPayoutDestinations.revoke({destinationId:request.params.destinationId,actorId:access.actor.id});
    await options.auditEvents.append(createAuditEvent({id:randomUUID(),category:"payout_governance",
      occurredAt:new Date().toISOString(),actor:{id:access.actor.id,type:"platform_user",role:access.actor.role},
      action:"platform.payout_destination.revoke",resourceType:"merchant_payout_destination",
      resourceId:request.params.destinationId,correlationId:request.id,source:"api",severity:"critical",
      type:result.outcome==="revoked"?"payout_destination.revoked":"payout_destination.revocation_rejected",
      outcome:result.outcome==="revoked"?"success":"failure",metadata:{reason:result.outcome}}));
    if(result.outcome==="not_found") return reply.code(404).send({error:"payout_destination_not_found"});
    if(result.outcome==="already_revoked") return reply.code(409).send({error:"payout_destination_already_revoked"});
    return reply.code(200).send({outcome:"revoked"});
  });

  app.post<{
    Params: { batchId: string };
    Body: { amountMinor?: number; idempotencyKey?: string };
  }>("/api/v1/platform/settlements/:batchId/payout-authorization-requests", async (request, reply) => {
    const access = await authorizeRequest(request, options, {
      resource: "platform.merchant_settlement", action: "create", scope: { platform: true }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    const roles = access.actor.roles ?? [access.actor.role];
    const requesterRole = roles.find((role): role is MerchantPayoutRequesterRole =>
      role === "operations" || role === "finance" || role === "platform_admin" || role === "platform_owner");
    if (!requesterRole) return reply.code(403).send({ error: "platform_payout_request_role_required" });
    const body = request.body;
    if (!body || !Number.isSafeInteger(body.amountMinor) || (body.amountMinor ?? 0) <= 0 ||
        typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim().length < 8 ||
        body.idempotencyKey.length > 240) {
      return reply.code(400).send({ error: "invalid_merchant_payout_request" });
    }
    if (!options.merchantPayoutAuthorization) return reply.code(503).send({ error: "merchant_payout_authorization_unavailable" });
    const result = await options.merchantPayoutAuthorization.request({
      settlementBatchId: request.params.batchId, amountMinor: body.amountMinor as number,
      idempotencyKey: body.idempotencyKey, requesterId: access.actor.id, requesterRole
    });
    if (result.outcome === "not_found") return reply.code(404).send({ error: "settlement_batch_not_found" });
    if (result.outcome === "already_active") return reply.code(409).send({ error: "merchant_payout_request_already_active_or_duplicate" });
    if (result.outcome === "invalid_batch") return reply.code(409).send({ error: "merchant_payout_requires_approved_settlement_and_exact_net_amount" });
    if (!("intent" in result)) return reply.code(409).send({ error: "merchant_payout_request_not_created" });
    return reply.code(201).send({ intent: result.intent, moneyTransferred: false });
  });

  app.get<{ Querystring: { limit?: string } }>(
    "/api/v1/platform/payout-authorization-requests", async (request, reply) => {
      const access = await authorizeRequest(request, options, {
        resource: "platform.merchant_settlement", action: "read", scope: { platform: true }
      });
      if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
      const roles = access.actor.roles ?? [access.actor.role];
      if (!roles.some(role => role === "finance" || role === "platform_admin" || role === "platform_owner")) {
        return reply.code(403).send({ error: "platform_payout_reviewer_role_required" });
      }
      if (!options.merchantPayoutAuthorization) return reply.code(503).send({ error: "merchant_payout_authorization_unavailable" });
      const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return reply.code(400).send({ error: "invalid_limit" });
      const intents = await options.merchantPayoutAuthorization.listPending({ limit });
      return reply.code(200).send({ intents });
    }
  );

  app.post<{
    Params: { payoutIntentId: string };
    Body: { decision?: string; reason?: string };
  }>("/api/v1/platform/payout-authorization-requests/:payoutIntentId/decision", async (request, reply) => {
    const access = await authorizeRequest(request, options, {
      resource: "platform.merchant_settlement", action: "approve", scope: { platform: true }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    const roles = access.actor.roles ?? [access.actor.role];
    const actorRole = roles.find((role): role is MerchantPayoutReviewerRole =>
      role === "finance" || role === "platform_admin" || role === "platform_owner");
    if (!actorRole) return reply.code(403).send({ error: "platform_payout_approver_role_required" });
    const body = request.body;
    if (!body || (body.decision !== "authorize" && body.decision !== "reject") ||
        (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 1000))) {
      return reply.code(400).send({ error: "invalid_merchant_payout_decision" });
    }
    if (!options.merchantPayoutAuthorization) return reply.code(503).send({ error: "merchant_payout_authorization_unavailable" });
    const result = await options.merchantPayoutAuthorization.decide({
      payoutIntentId: request.params.payoutIntentId, actorId: access.actor.id, actorRole,
      decision: body.decision, ...(body.reason === undefined ? {} : { reason: body.reason })
    });
    if (result.outcome === "not_found") return reply.code(404).send({ error: "merchant_payout_intent_not_found" });
    if (result.outcome === "self_approval") return reply.code(403).send({ error: "payout_requester_cannot_approve_own_request" });
    if (result.outcome === "already_decided") return reply.code(409).send({ error: "merchant_payout_already_decided" });
    if (result.outcome === "invalid_transition") return reply.code(409).send({ error: "merchant_payout_transition_invalid" });
    if (!("intent" in result)) return reply.code(409).send({ error: "merchant_payout_decision_not_recorded" });
    return reply.code(200).send({ intent: result.intent, moneyTransferred: false });
  });

  app.post<{
    Params: { payoutIntentId: string };
    Body: { destinationId?: string; providerKey?: string; idempotencyKey?: string };
  }>("/api/v1/platform/payout-authorization-requests/:payoutIntentId/provider-submission", async (request, reply) => {
    const access = await authorizeRequest(request, options, {
      resource: "platform.merchant_settlement", action: "approve", scope: { platform: true }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    const roles = access.actor.roles ?? [access.actor.role];
    if (!roles.some(role => role === "finance")) {
      return reply.code(403).send({ error: "platform_payout_dispatch_role_required" });
    }
    const body = request.body;
    if (!body || typeof body.destinationId !== "string" || !body.destinationId.trim() ||
        typeof body.providerKey !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(body.providerKey) ||
        typeof body.idempotencyKey !== "string" || !/^[a-zA-Z0-9._:-]{8,240}$/.test(body.idempotencyKey)) {
      return reply.code(400).send({ error: "invalid_merchant_payout_provider_submission" });
    }
    if (!options.merchantPayoutProviderOutbox) {
      return reply.code(503).send({ error: "merchant_payout_provider_outbox_unavailable" });
    }
    const result = await options.merchantPayoutProviderOutbox.enqueue({
      payoutIntentId: request.params.payoutIntentId,
      destinationId: body.destinationId, providerKey: body.providerKey,
      idempotencyKey: body.idempotencyKey, actorId: access.actor.id
    });
    if (result.outcome === "not_found") return reply.code(404).send({ error: "merchant_payout_intent_not_found" });
    if (result.outcome === "not_authorized") return reply.code(409).send({ error: "merchant_payout_intent_not_authorized" });
    if (result.outcome === "destination_unverified") return reply.code(409).send({ error: "merchant_payout_destination_not_verified" });
    if (result.outcome === "provider_entity_inactive") return reply.code(409).send({ error: "merchant_payout_provider_entity_inactive" });
    if (result.outcome === "idempotency_conflict") return reply.code(409).send({ error: "merchant_payout_provider_idempotency_conflict" });
    if (!("outboxId" in result)) return reply.code(409).send({ error: "merchant_payout_provider_submission_not_queued" });
    return reply.code(202).send({ outcome: "queued", outboxId: result.outboxId, moneyTransferred: false });
  });

  app.get<{
    Params: { merchantId: string };
    Querystring: { status?: string; limit?: string };
  }>("/api/v1/merchants/:merchantId/settlements", async (request, reply) => {
    const { merchantId } = request.params;
    const access = await authorizeRequest(request, options, {
      resource: "merchant.settlement", action: "read", scope: { merchantId }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    if (!(access.actor.roles ?? [access.actor.role]).some(role => role === "merchant_owner" || role === "merchant_admin")) {
      return reply.code(403).send({ error: "merchant_settlement_role_required" });
    }
    if (!options.resolveMerchantTenantId || !options.merchantSettlementReader) {
      return reply.code(503).send({ error: "service_unavailable" });
    }
    const status = request.query.status;
    if (status !== undefined && status !== "draft" && status !== "approved") {
      return reply.code(400).send({ error: "invalid_status" });
    }
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return reply.code(400).send({ error: "invalid_limit" });
    }
    const tenantId = await options.resolveMerchantTenantId(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "not_found" });
    const batches = await options.merchantSettlementReader.list({
      tenantId, merchantId, ...(status === undefined ? {} : { status }), limit
    });
    return reply.code(200).send({ batches });
  });

  app.get<{
    Params: { merchantId: string; batchId: string };
  }>("/api/v1/merchants/:merchantId/settlements/:batchId", async (request, reply) => {
    const { merchantId, batchId } = request.params;
    const access = await authorizeRequest(request, options, {
      resource: "merchant.settlement", action: "read", scope: { merchantId }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    if (!(access.actor.roles ?? [access.actor.role]).some(role => role === "merchant_owner" || role === "merchant_admin")) {
      return reply.code(403).send({ error: "merchant_settlement_role_required" });
    }
    if (!options.resolveMerchantTenantId || !options.merchantSettlementReader) {
      return reply.code(503).send({ error: "service_unavailable" });
    }
    const tenantId = await options.resolveMerchantTenantId(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "not_found" });
    const batch = await options.merchantSettlementReader.get({ tenantId, merchantId, batchId });
    if (!batch) return reply.code(404).send({ error: "not_found" });
    return reply.code(200).send(batch);
  });

  // Authentication and authorization always precede adapter availability checks and data access.
  app.get<{
    Params: { merchantId: string; branchId: string };
    Querystring: { status?: string; limit?: string };
  }>("/api/v1/merchants/:merchantId/branches/:branchId/orders", async (request, reply) => {
    const { merchantId, branchId } = request.params;
    const access = await authorizeRequest(request, options, {
      resource: "merchant.order", action: "read", scope: { merchantId, branchId }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    const merchantRoles = ["merchant_employee", "branch_manager", "merchant_admin", "merchant_owner"] as const;
    if (!merchantRoles.includes(access.actor.role as typeof merchantRoles[number])) {
      return reply.code(403).send({ error: "merchant_role_required" });
    }
    if (!options.merchantOrderReader || !options.resolveMerchantTenantId) {
      return reply.code(503).send({ error: "merchant_order_reader_unavailable" });
    }
    const status = request.query.status;
    if (status !== undefined && !ORDER_STATUSES.includes(status as OrderStatus)) {
      return reply.code(400).send({ error: "invalid_order_status" });
    }
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return reply.code(400).send({ error: "invalid_limit" });
    }
    const tenantId = await options.resolveMerchantTenantId(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const orders = await options.merchantOrderReader.listForBranch({
      tenantId, merchantId, branchId,
      ...(status === undefined ? {} : { status: status as OrderStatus }),
      limit
    });
    return reply.code(200).send({ orders });
  });

  app.get<{
    Params: { merchantId: string; branchId: string };
  }>("/api/v1/merchants/:merchantId/branches/:branchId/summary", async (request, reply) => {
    const result = await authorizeRequest(request, options, {
      resource: "merchant.branch",
      action: "read",
      scope: {
        merchantId: request.params.merchantId,
        branchId: request.params.branchId
      }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!options.merchantBranches) return reply.code(503).send({ error: "service_unavailable" });

    const branch = await options.merchantBranches.findBranchSummary({
      merchantId: request.params.merchantId,
      branchId: request.params.branchId
    });
    if (!branch) return reply.code(404).send({ error: "not_found" });
    return reply.code(200).send({ branch });
  });

  app.post<{
    Params: { merchantId: string };
    Body: {
      branchId: string;
      displayName: string;
      cityCode: string;
      address?: Record<string, unknown>;
      latitude?: number;
      longitude?: number;
    };
  }>("/api/v1/merchants/:merchantId/branches", async (request, reply) => {
    const result = await authorizeRequest(request, options, {
      resource: "merchant.branch",
      action: "create",
      scope: { merchantId: request.params.merchantId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!options.merchantBranchWriter) return reply.code(503).send({ error: "service_unavailable" });

    const body = request.body;
    if (!body || typeof body.branchId !== "string" || !/^[a-zA-Z0-9_-]{2,80}$/.test(body.branchId) ||
        typeof body.displayName !== "string" || body.displayName.trim().length < 2 ||
        body.displayName.trim().length > 120 ||
        typeof body.cityCode !== "string" || !/^[A-Z0-9_-]{2,12}$/.test(body.cityCode) ||
        (body.address !== undefined && (typeof body.address !== "object" || body.address === null || Array.isArray(body.address))) ||
        ((body.latitude === undefined) !== (body.longitude === undefined)) ||
        (body.latitude !== undefined && (!Number.isFinite(body.latitude) || body.latitude < -90 || body.latitude > 90)) ||
        (body.longitude !== undefined && (!Number.isFinite(body.longitude) || body.longitude < -180 || body.longitude > 180))) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const created = await options.merchantBranchWriter.createBranch({
      merchantId: request.params.merchantId,
      branchId: body.branchId,
      displayName: body.displayName.trim(),
      cityCode: body.cityCode,
      ...(body.address === undefined ? {} : { address: body.address }),
      ...(body.latitude === undefined ? {} : { latitude: body.latitude }),
      ...(body.longitude === undefined ? {} : { longitude: body.longitude })
    });
    if (created === "merchant_not_found") return reply.code(404).send({ error: "merchant_not_found" });
    if (created === "merchant_inactive") return reply.code(409).send({ error: "merchant_inactive" });
    if (created === "already_exists") return reply.code(409).send({ error: "branch_already_exists" });
    return reply.code(201).send({
      branch: {
        merchantId: request.params.merchantId,
        branchId: body.branchId,
        displayName: body.displayName.trim(),
        cityCode: body.cityCode,
        status: "active"
      }
    });
  });

app.patch<{
    Params: { merchantId: string; branchId: string };
    Body: {
      displayName: string;
      cityCode: string;
      address?: Record<string, unknown>;
      latitude?: number;
      longitude?: number;
      status: "active" | "inactive";
    };
  }>("/api/v1/merchants/:merchantId/branches/:branchId", async (request, reply) => {
    const result = await authorizeRequest(request, options, {
      resource: "merchant.branch",
      action: "update",
      scope: { merchantId: request.params.merchantId, branchId: request.params.branchId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!options.merchantBranchWriter) return reply.code(503).send({ error: "service_unavailable" });
    const body = request.body;
    if (!body || typeof body.displayName !== "string" || body.displayName.trim().length < 2 ||
        body.displayName.trim().length > 120 ||
        typeof body.cityCode !== "string" || !/^[A-Z0-9_-]{2,12}$/.test(body.cityCode) ||
        !["active", "inactive"].includes(body.status) ||
        (body.address !== undefined && (typeof body.address !== "object" || body.address === null || Array.isArray(body.address))) ||
        ((body.latitude === undefined) !== (body.longitude === undefined)) ||
        (body.latitude !== undefined && (!Number.isFinite(body.latitude) || body.latitude < -90 || body.latitude > 90)) ||
        (body.longitude !== undefined && (!Number.isFinite(body.longitude) || body.longitude < -180 || body.longitude > 180))) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const updated = await options.merchantBranchWriter.updateBranch({
      merchantId: request.params.merchantId,
      branchId: request.params.branchId,
      displayName: body.displayName.trim(),
      cityCode: body.cityCode,
      status: body.status,
      ...(body.address === undefined ? {} : { address: body.address }),
      ...(body.latitude === undefined ? {} : { latitude: body.latitude }),
      ...(body.longitude === undefined ? {} : { longitude: body.longitude })
    });
    if (updated === "merchant_not_found") return reply.code(404).send({ error: "merchant_not_found" });
    if (updated === "merchant_inactive") return reply.code(409).send({ error: "merchant_inactive" });
    if (updated === "not_found") return reply.code(404).send({ error: "branch_not_found" });
    return reply.code(200).send({ branch: {
      merchantId: request.params.merchantId, branchId: request.params.branchId,
      displayName: body.displayName.trim(), cityCode: body.cityCode, status: body.status
    } });
  });


  app.post<{
    Params: { merchantId: string; branchId: string; orderId: string; suborderId: string };
    Body: { taskId: string };
  }>("/api/v1/merchants/:merchantId/branches/:branchId/orders/:orderId/suborders/:suborderId/pickup-code", async (request, reply) => {
    const { merchantId, branchId, orderId, suborderId } = request.params;
    const access = await authorizeRequest(request, options, {
      resource: "merchant.order", action: "update", scope: { merchantId, branchId, orderId }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    const merchantRoles = ["merchant_employee", "branch_manager", "merchant_admin", "merchant_owner"] as const;
    if (!merchantRoles.includes(access.actor.role as typeof merchantRoles[number])) {
      return reply.code(403).send({ error: "merchant_role_required" });
    }
    if (!options.courierPickupCodeIssuer) return reply.code(503).send({ error: "pickup_code_issuance_unavailable" });
    const body = request.body;
    if (!body || typeof body.taskId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(body.taskId) ||
        Object.keys(body).some(key => key !== "taskId")) {
      return reply.code(400).send({ error: "invalid_pickup_code_request" });
    }
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const result = await options.courierPickupCodeIssuer.issue({
      tenantId, merchantId, branchId, orderId, suborderId, taskId: body.taskId,
      actorId: access.actor.id,
      actorRole: access.actor.role as typeof merchantRoles[number]
    });
    if (result.outcome === "not_found") return reply.code(404).send({ error: "courier_task_not_found" });
    if (result.outcome === "not_ready") return reply.code(409).send({ error: "suborder_or_task_not_ready" });
    if (result.outcome === "invalid_actor") return reply.code(403).send({ error: "merchant_role_required" });
    if (result.outcome === "rate_limited") {
      reply.header("retry-after", "900");
      return reply.code(429).send({ error: "pickup_code_issuance_rate_limited", retryAfterSeconds: 900 });
    }
    if (result.outcome !== "issued") return reply.code(409).send({ error: "pickup_code_issuance_rejected" });
    // This is the sole response that may contain the plaintext code. Never log it.
    return reply.code(201).send({ outcome: "issued", code: result.code, expiresAtUtc: result.expiresAtUtc });
  });

  app.post<{
    Params: { merchantId: string; branchId: string; orderId: string; suborderId: string; itemId: string };
    Body: { scannedSku?: string; verifiedQuantity: number; outcome: "verified" | "shortage" | "damaged" | "sku_mismatch"; note?: string };
  }>("/api/v1/merchants/:merchantId/branches/:branchId/orders/:orderId/suborders/:suborderId/items/:itemId/preparation-checks", async (request, reply) => {
    const { merchantId, branchId, orderId, suborderId, itemId } = request.params;
    const access = await authorizeRequest(request, options, {
      resource: "merchant.order", action: "update", scope: { merchantId, branchId, orderId }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    if (!["merchant_employee", "branch_manager", "merchant_admin", "merchant_owner"].includes(access.actor.role)) {
      return reply.code(403).send({ error: "preparation_role_required" });
    }
    if (!options.merchantOrderItemPreparation) return reply.code(503).send({ error: "preparation_check_unavailable" });
    const body = request.body;
    if (!body || !Number.isSafeInteger(body.verifiedQuantity) || body.verifiedQuantity < 0 ||
        !["verified", "shortage", "damaged", "sku_mismatch"].includes(body.outcome) ||
        (body.scannedSku !== undefined && (typeof body.scannedSku !== "string" || body.scannedSku.length > 120)) ||
        (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 1000))) {
      return reply.code(400).send({ error: "invalid_preparation_check" });
    }
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const input: RecordPreparationCheckInput = {
      id: randomUUID(), tenantId, orderId, suborderId, orderItemId: itemId,
      merchantId, branchId, actorId: access.actor.id,
      ...(body.scannedSku === undefined ? {} : { scannedSku: body.scannedSku }),
      verifiedQuantity: body.verifiedQuantity, outcome: body.outcome,
      ...(body.note === undefined ? {} : { note: body.note })
    };
    const result = await options.merchantOrderItemPreparation.record(input);
    if (result.outcome === "not_found") return reply.code(404).send({ error: "order_item_not_found" });
    if (result.outcome === "conflict") return reply.code(409).send({ error: "preparation_check_conflict" });
    if (result.outcome === "invalid_check") return reply.code(422).send({ error: result.reason });
    return reply.code(result.outcome === "recorded" ? 201 : 200).send(result);
  });

  app.post<{
    Params: { merchantId: string; branchId: string; orderId: string; suborderId: string };
    Body: { nextStatus: OrderStatus; expectedVersion: number; reason?: string };
  }>("/api/v1/merchants/:merchantId/branches/:branchId/orders/:orderId/suborders/:suborderId/transitions", async (request, reply) => {
    const { merchantId, branchId, orderId, suborderId } = request.params;
    const result = await authorizeRequest(request, options, {
      resource: "merchant.order", action: "update", scope: { merchantId, branchId, orderId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!options.orderTransitions) return reply.code(503).send({ error: "service_unavailable" });
    const body = request.body;
    if (!body || !ORDER_STATUSES.includes(body.nextStatus) ||
        !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 ||
        (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.trim().length > 500))) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    // Store employees may only operate the preparation lane for their assigned branch.
    // They cannot cancel, refund, dispatch, or change delivery/custody states.
    if (result.actor.role === "merchant_employee" &&
        !["preparing", "ready_for_pickup", "stock_unavailable"].includes(body.nextStatus)) {
      return reply.code(403).send({ error: "employee_preparation_transition_only" });
    }
    // Resolve the merchant's tenant from trusted persistence; merchantId is not tenantId.
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    // Checkout validation is customer/platform-owned; merchant actors cannot make an order payable.
    if (body.nextStatus === "awaiting_payment") {
      return reply.code(403).send({ error: "customer_checkout_transition_only" });
    }
    const context: OrderTransitionContext = {
      actorId: result.actor.id, actorRole: result.actor.role,
      occurredAt: new Date().toISOString(), expectedVersion: body.expectedVersion,
      paymentAuthorized: false, inventoryReserved: false,
      deliveryProofVerified: false, refundConfirmed: false,
      ...(body.reason === undefined ? {} : { reason: body.reason.trim() })
    };
    const actorType = ["merchant_owner", "merchant_admin", "branch_manager", "merchant_employee"].includes(result.actor.role)
      ? "merchant_user" : result.actor.role === "customer" ? "customer" :
        result.actor.role === "shopper" ? "shopper" : result.actor.role === "courier" ? "courier" :
        result.actor.role === "ai_agent" ? "ai_agent" : "platform_user";
    const auditEvent = createAuditEvent({
      id: randomUUID(), type: "order.suborder.transitioned", category: "order_lifecycle",
      occurredAt: context.occurredAt, actor: { id: result.actor.id, type: actorType, role: result.actor.role },
      action: "order.suborder.transition", outcome: "success",
      resourceType: "merchant_suborder", resourceId: suborderId,
      tenantId, merchantId, branchId, correlationId: request.id,
      source: "api", severity: "info",
      metadata: { orderId, nextStatus: body.nextStatus, expectedVersion: body.expectedVersion }
    });
    const persisted = await options.orderTransitions.transitionSuborder({
      tenantId, orderId, suborderId, nextStatus: body.nextStatus, context, auditEvent
    });
    if (persisted.outcome === "not_found") return reply.code(404).send({ error: "not_found" });
    if (persisted.outcome === "conflict") return reply.code(409).send({ error: "version_conflict" });
    if (persisted.outcome === "rejected") return reply.code(409).send({ error: persisted.reason });
    return reply.code(200).send({
      suborder: { id: suborderId, status: persisted.transition.order.status, version: persisted.transition.order.version },
      previousStatus: persisted.transition.previousStatus, parentStatus: persisted.parentStatus
    });
  });

  app.get("/api/v1/customer/cart", async (request, reply) => {
    const auth = await authorizeRequest(request, options, actor => ({
      resource: "customer.cart", action: "read", scope: { customerId: actor.id }
    }));
    if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
    if (auth.actor.role !== "customer") return reply.code(403).send({ error: "customer_only" });
    if (!options.customerCart) return reply.code(503).send({ error: "customer_cart_unavailable" });
    const cart = await options.customerCart.get({ customerId: auth.actor.id });
    return reply.code(200).send({ cart });
  });

  app.post<{ Body: { merchantId: string; branchId: string; productVariantId: string; quantity: number } }>(
    "/api/v1/customer/cart/items", async (request, reply) => {
      const auth = await authorizeRequest(request, options, actor => ({
        resource: "customer.cart", action: "create", scope: { customerId: actor.id }
      }));
      if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
      if (auth.actor.role !== "customer") return reply.code(403).send({ error: "customer_only" });
      if (!options.customerCart) return reply.code(503).send({ error: "customer_cart_unavailable" });
      const body = request.body;
      if (!body || typeof body.merchantId !== "string" || !body.merchantId.trim() ||
          typeof body.branchId !== "string" || !body.branchId.trim() ||
          typeof body.productVariantId !== "string" || !body.productVariantId.trim() ||
          !Number.isSafeInteger(body.quantity) || body.quantity < 1 || body.quantity > 99) {
        return reply.code(400).send({ error: "invalid_cart_item" });
      }
      try {
        const cart = await options.customerCart.addItem({
          customerId: auth.actor.id, merchantId: body.merchantId, branchId: body.branchId,
          productVariantId: body.productVariantId, quantity: body.quantity
        });
        return reply.code(200).send({ cart });
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code === "customer_cart_variant_unavailable") return reply.code(409).send({ error: "cart_variant_unavailable" });
        if (code === "customer_cart_currency_mismatch") return reply.code(409).send({ error: "cart_currency_mismatch" });
        if (code === "customer_cart_quantity_limit") return reply.code(409).send({ error: "cart_quantity_limit" });
        throw error;
      }
    }
  );

  app.delete<{ Params: { itemId: string } }>("/api/v1/customer/cart/items/:itemId", async (request, reply) => {
    const auth = await authorizeRequest(request, options, actor => ({
      resource: "customer.cart", action: "delete", scope: { customerId: actor.id }
    }));
    if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
    if (auth.actor.role !== "customer") return reply.code(403).send({ error: "customer_only" });
    if (!options.customerCart) return reply.code(503).send({ error: "customer_cart_unavailable" });
    const cart = await options.customerCart.removeItem({ customerId: auth.actor.id, itemId: request.params.itemId });
    return reply.code(200).send({ cart });
  });

  app.post<{
    Body: {
      expectedCartVersion: number;
      destination: {
        countryCode: string; cityCode: string; serviceCode: string;
        latitude: number; longitude: number; addressSnapshot?: Record<string, unknown>;
      };
    };
  }>("/api/v1/customer/checkout", async (request, reply) => {
    const auth = await authorizeRequest(request, options, actor => ({
      resource: "customer.cart", action: "create", scope: { customerId: actor.id }
    }));
    if (!auth.actor) return sendAuthorizationFailure(reply, auth.statusCode, auth.decision.reason);
    if (auth.actor.role !== "customer") return reply.code(403).send({ error: "customer_only" });
    if (!options.customerCheckout) return reply.code(503).send({ error: "customer_checkout_unavailable" });

    const body = request.body;
    const idempotencyKey = request.headers["idempotency-key"];
    const destination = body?.destination;
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8 ||
        idempotencyKey.length > 200 || !body ||
        !Number.isSafeInteger(body.expectedCartVersion) || body.expectedCartVersion < 1 ||
        !destination || typeof destination !== "object" ||
        typeof destination.countryCode !== "string" || !/^[A-Z]{2}$/.test(destination.countryCode) ||
        typeof destination.cityCode !== "string" || !destination.cityCode.trim() ||
        typeof destination.serviceCode !== "string" || !destination.serviceCode.trim() ||
        typeof destination.latitude !== "number" || !Number.isFinite(destination.latitude) ||
        destination.latitude < -90 || destination.latitude > 90 ||
        typeof destination.longitude !== "number" || !Number.isFinite(destination.longitude) ||
        destination.longitude < -180 || destination.longitude > 180 ||
        (destination.addressSnapshot !== undefined &&
          (destination.addressSnapshot === null || typeof destination.addressSnapshot !== "object" ||
           Array.isArray(destination.addressSnapshot)))) {
      return reply.code(400).send({ error: "invalid_checkout_request" });
    }

    const result = await options.customerCheckout.create({
      customerId: auth.actor.id,
      expectedCartVersion: body.expectedCartVersion,
      idempotencyKey,
      destination,
      actorId: auth.actor.id,
      actorRole: "customer",
      correlationId: request.id
    });
    if (result.outcome === "created") return reply.code(201).send(result);
    if (result.outcome === "not_found") return reply.code(404).send({ error: result.outcome });
    if (result.outcome === "invalid_delivery_request") return reply.code(400).send({ error: result.outcome });
    if (result.outcome === "outside_service_area" || result.outcome === "unavailable" ||
        result.outcome === "invalid_snapshot" || result.outcome === "empty") {
      return reply.code(422).send({ error: result.outcome });
    }
    return reply.code(409).send({ error: result.outcome });
  });

  app.patch<{
    Params: { orderId: string };
    Body: { latitude: number; longitude: number };
  }>("/api/v1/customer/orders/:orderId/delivery-destination", async (request, reply) => {
    const result = await authorizeRequest(request, options, {
      resource: "customer.order", action: "update", scope: { orderId: request.params.orderId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (result.actor.role !== "customer") return reply.code(403).send({ error: "customer_only" });
    if (!options.customerDeliveryDestinations) return reply.code(503).send({ error: "service_unavailable" });
    const body = request.body;
    if (!body || typeof body.latitude !== "number" || !Number.isFinite(body.latitude) ||
        body.latitude < -90 || body.latitude > 90 || typeof body.longitude !== "number" ||
        !Number.isFinite(body.longitude) || body.longitude < -180 || body.longitude > 180) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const updated = await options.customerDeliveryDestinations.update({
      customerId: result.actor.id, actorId: result.actor.id, orderId: request.params.orderId,
      destination: { latitude: body.latitude, longitude: body.longitude }
    });
    if (updated.outcome !== "updated") {
      const statusCode = updated.outcome === "not_found" ? 404 :
        updated.outcome === "outside_service_area" ? 422 :
        updated.outcome === "invalid_destination" ? 400 :
        updated.outcome === "invalid_service_area" || updated.outcome === "invalid_quote" ? 503 : 409;
      const error = updated.outcome === "invalid_service_area" || updated.outcome === "invalid_quote"
        ? "delivery_quote_unavailable" : updated.outcome;
      return reply.code(statusCode).send({
        error,
        ...(updated.outcome === "payment_adjustment_required"
          ? { message: "A payment adjustment must be authorized and confirmed before this destination change can be applied." }
          : {})
      });
    }
    return reply.code(200).send({
      outcome: "updated", branchChanged: updated.branchChanged,
      delivery: {
        branchId: updated.quote.branchId, deliveryFeeMinor: updated.quote.deliveryFeeMinor,
        totalMinor: updated.quote.totalMinor, currency: updated.quote.currency,
        estimatedDeliveryAtUtc: updated.quote.estimatedDeliveryAtUtc,
        quoteReference: updated.quote.quoteReference, expiresAtUtc: updated.quote.expiresAtUtc
      }
    });
  });

  app.post<{Params:{orderId:string}}>("/api/v1/customer/orders/:orderId/payment-intents",async(request,reply)=>{
    const auth=await authorizeRequest(request,options,{resource:"customer.order",action:"update",scope:{orderId:request.params.orderId}});
    if(!auth.actor)return sendAuthorizationFailure(reply,auth.statusCode,auth.decision.reason);
    if(auth.actor.role!=="customer")return reply.code(403).send({error:"customer_only"});
    if(!options.customerPaymentIntentCheckout)return reply.code(503).send({error:"payment_checkout_unavailable"});
    const key=request.headers["idempotency-key"]; if(typeof key!=="string")return reply.code(400).send({error:"idempotency_key_required"});
    const result=await options.customerPaymentIntentCheckout.create({customerId:auth.actor.id,orderId:request.params.orderId,idempotencyKey:key});
    if(result.outcome==="not_found")return reply.code(404).send({error:"order_not_found"});
    if(result.outcome==="order_not_payable")return reply.code(409).send({error:"order_not_payable"});
    if(result.outcome==="attempt_exists")return reply.code(409).send({error:"payment_attempt_exists"});
    if(result.outcome==="idempotency_conflict")return reply.code(409).send({error:"idempotency_conflict"});
    if(result.outcome==="outcome_unknown")return reply.code(202).send({outcome:"outcome_unknown"});
    if(result.outcome==="provider_rejected")return reply.code(502).send({error:"payment_provider_rejected"});
    if(result.outcome==="persistence_conflict")return reply.code(503).send({error:"payment_intent_persistence_conflict"});
    if(result.outcome==="recovery_unavailable")return reply.code(503).send({error:"payment_intent_recovery_unavailable"});
    return reply.code(201).send(result);
  });

  app.get<{
    Params: { orderId: string; adjustmentId: string };
  }>("/api/v1/customer/orders/:orderId/payment-adjustments/:adjustmentId", async (request, reply) => {
    const result = await authorizeRequest(request, options, {
      resource: "customer.order", action: "read", scope: { orderId: request.params.orderId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (result.actor.role !== "customer") return reply.code(403).send({ error: "customer_only" });
    const reader = options.customerPaymentAdjustments?.getCustomerAdjustment;
    if (!reader) return reply.code(503).send({ error: "service_unavailable" });
    const outcome = await reader({
      orderId: request.params.orderId, adjustmentId: request.params.adjustmentId,
      customerId: result.actor.id
    });
    if (outcome.outcome === "not_found") return reply.code(404).send({ error: "not_found" });
    return reply.code(200).send(outcome.adjustment);
  });

  app.post<{
    Params: { orderId: string; adjustmentId: string };
  }>("/api/v1/customer/orders/:orderId/payment-adjustments/:adjustmentId/consent", async (request, reply) => {
    const result = await authorizeRequest(request, options, {
      resource: "customer.order", action: "update", scope: { orderId: request.params.orderId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (result.actor.role !== "customer") return reply.code(403).send({ error: "customer_only" });
    if (!options.customerPaymentAdjustments) return reply.code(503).send({ error: "service_unavailable" });
    const input = {
      orderId: request.params.orderId, adjustmentId: request.params.adjustmentId,
      customerId: result.actor.id
    };
    const outcome = options.customerPaymentAdjustments.consentAndQueue
      ? await options.customerPaymentAdjustments.consentAndQueue(input)
      : await options.customerPaymentAdjustments.consent(input);
    if (outcome.outcome === "not_found") return reply.code(404).send({ error: "not_found" });
    if (outcome.outcome === "expired") return reply.code(410).send({ error: "adjustment_expired" });
    if (outcome.outcome === "provider_pending") {
      return reply.code(202).send({
        outcome: "provider_pending", submissionId: outcome.submissionId,
        message: "Customer consent and provider submission were durably queued; provider confirmation is still pending."
      });
    }
    if (outcome.outcome !== "consented") return reply.code(409).send({ error: "adjustment_not_pending" });
    return reply.code(200).send({ outcome: "consented", message: "Customer consent recorded; provider submission is not configured." });
  });

  app.post<{
    Params: { orderId: string; adjustmentId: string };
  }>("/api/v1/customer/orders/:orderId/payment-adjustments/:adjustmentId/decline", async (request, reply) => {
    const result = await authorizeRequest(request, options, {
      resource: "customer.order", action: "update", scope: { orderId: request.params.orderId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (result.actor.role !== "customer") return reply.code(403).send({ error: "customer_only" });
    if (!options.customerPaymentAdjustments) return reply.code(503).send({ error: "service_unavailable" });
    const outcome = await options.customerPaymentAdjustments.decline({
      orderId: request.params.orderId, adjustmentId: request.params.adjustmentId,
      customerId: result.actor.id
    });
    if (outcome.outcome === "not_found") return reply.code(404).send({ error: "not_found" });
    if (outcome.outcome === "expired") return reply.code(410).send({ error: "adjustment_expired" });
    if (outcome.outcome !== "declined") return reply.code(409).send({ error: "adjustment_not_pending" });
    return reply.code(200).send({ outcome: "declined", orderUnchanged: true });
  });


  app.post<{
    Params: { merchantId: string; integrationId: string };
  }>("/api/v1/merchants/:merchantId/integrations/:integrationId/salla/oauth/start", async (request, reply) => {
    const { merchantId, integrationId } = request.params;
    const result = await authorizeRequest(request, options, {
      resource: "merchant.integration", action: "update", scope: { merchantId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!["merchant_owner", "merchant_admin"].includes(result.actor.role)) {
      return reply.code(403).send({ error: "merchant_admin_only" });
    }
    if (!options.sallaOAuthFlow) return reply.code(503).send({ error: "salla_oauth_not_configured" });
    if (!/^[a-zA-Z0-9_-]{2,80}$/.test(integrationId)) return reply.code(400).send({ error: "invalid_integration_id" });
    if (!options.integrationHub) return reply.code(503).send({ error: "service_unavailable" });
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const integration = await options.integrationHub.get(tenantId, integrationId);
    if (!integration) return reply.code(404).send({ error: "integration_not_found" });
    if (integration.providerKey !== "salla" || integration.family !== "commerce") {
      return reply.code(409).send({ error: "integration_provider_mismatch" });
    }
    if (integration.status !== "pending") {
      return reply.code(409).send({ error: "integration_must_be_pending_before_authorization" });
    }
    const started = await options.sallaOAuthFlow.begin({ tenantId, integrationId });
    let url: URL;
    try { url = new URL(started.authorizationUrl); } catch { return reply.code(502).send({ error: "invalid_provider_authorization_url" }); }
    if (url.protocol !== "https:" || url.hostname !== "accounts.salla.sa" || url.username || url.password) {
      return reply.code(502).send({ error: "invalid_provider_authorization_url" });
    }
    return reply.code(200).send({ authorizationUrl: url.toString() });
  });

  // Public callback: the injected flow service must consume and validate one-time state before storing tokens.
  app.get<{
    Querystring: { code?: string; state?: string; error?: string };
  }>("/api/v1/integrations/salla/oauth/callback", async (request, reply) => {
    if (!options.sallaOAuthFlow) return reply.code(503).send({ error: "salla_oauth_not_configured" });
    const { code, state, error } = request.query;
    if (error) return reply.code(400).send({ error: "salla_authorization_denied" });
    if (typeof code !== "string" || code.length < 1 || code.length > 4096 ||
        typeof state !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(state)) {
      return reply.code(400).send({ error: "invalid_oauth_callback" });
    }
    try {
      const completed = await options.sallaOAuthFlow.complete({ code, state });
      return reply.code(200).send({ outcome: "authorized", integrationId: completed.integrationId });
    } catch {
      return reply.code(400).send({ error: "oauth_callback_rejected" });
    }
  });

  app.get<{
    Params: { merchantId: string };
    Querystring: { family?: string };
  }>("/api/v1/merchants/:merchantId/integrations", async (request, reply) => {
    const { merchantId } = request.params;
    const result = await authorizeRequest(request, options, {
      resource: "merchant.integration", action: "read", scope: { merchantId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!["merchant_owner", "merchant_admin"].includes(result.actor.role)) {
      return reply.code(403).send({ error: "merchant_admin_only" });
    }
    if (!options.integrationHub) return reply.code(503).send({ error: "service_unavailable" });
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const family = request.query.family;
    if (family !== undefined && !INTEGRATION_FAMILIES.includes(family as typeof INTEGRATION_FAMILIES[number])) {
      return reply.code(400).send({ error: "invalid_integration_family" });
    }
    const integrations = await options.integrationHub.list(
      tenantId, family as typeof INTEGRATION_FAMILIES[number] | undefined
    );
    return reply.code(200).send({ integrations });
  });

  app.put<{
    Params: { merchantId: string; integrationId: string };
    Body: { secretReference: string };
  }>("/api/v1/merchants/:merchantId/integrations/:integrationId/secret-reference", async (request, reply) => {
    const { merchantId, integrationId } = request.params;
    const result = await authorizeRequest(request, options, {
      resource: "merchant.integration", action: "update", scope: { merchantId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!["merchant_owner", "merchant_admin"].includes(result.actor.role)) {
      return reply.code(403).send({ error: "merchant_admin_only" });
    }
    if (!options.integrationHub) return reply.code(503).send({ error: "service_unavailable" });
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const body = request.body;
    if (!body || typeof body.secretReference !== "string") {
      return reply.code(400).send({ error: "invalid_secret_reference" });
    }
    const outcome = await options.integrationHub.rotateSecretReference(
      tenantId, integrationId, body.secretReference, new Date().toISOString()
    );
    if (outcome === "not_found") return reply.code(404).send({ error: "integration_not_found" });
    if (outcome === "validator_not_configured") return reply.code(503).send({ error: "secret_manager_not_configured" });
    if (outcome === "invalid_reference") return reply.code(400).send({ error: "secret_reference_not_authorized" });
    return reply.code(200).send({ outcome: "rotated", integrationId });
  });

  app.post<{
    Params: { merchantId: string; integrationId: string };
  }>("/api/v1/merchants/:merchantId/integrations/:integrationId/reconnect", async (request, reply) => {
    const { merchantId, integrationId } = request.params;
    const result = await authorizeRequest(request, options, {
      resource: "merchant.integration", action: "update", scope: { merchantId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!["merchant_owner", "merchant_admin"].includes(result.actor.role)) {
      return reply.code(403).send({ error: "merchant_admin_only" });
    }
    if (!options.integrationHub) return reply.code(503).send({ error: "service_unavailable" });
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const outcome = await options.integrationHub.reconnect(tenantId, integrationId, new Date().toISOString());
    if (outcome === "not_found") return reply.code(404).send({ error: "integration_not_found" });
    if (outcome === "invalid_transition") return reply.code(409).send({ error: "integration_cannot_be_reconnected" });
    return reply.code(200).send({ outcome: "pending", integrationId, requiresVerification: true });
  });

  app.post<{
    Params: { merchantId: string; integrationId: string };
  }>("/api/v1/merchants/:merchantId/integrations/:integrationId/verify", async (request, reply) => {
    const { merchantId, integrationId } = request.params;
    const result = await authorizeRequest(request, options, {
      resource: "merchant.integration", action: "update", scope: { merchantId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!["merchant_owner", "merchant_admin"].includes(result.actor.role)) {
      return reply.code(403).send({ error: "merchant_admin_only" });
    }
    if (!options.integrationHub) return reply.code(503).send({ error: "service_unavailable" });
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const outcome = await options.integrationHub.verifyConnection(
      tenantId, integrationId, new Date().toISOString()
    );
    if (outcome === "not_found") return reply.code(404).send({ error: "integration_not_found" });
    if (outcome === "provider_not_configured") return reply.code(503).send({ error: "provider_not_configured" });
    if (outcome === "invalid_transition") return reply.code(409).send({ error: "integration_cannot_be_verified" });
    if (outcome === "verification_failed") return reply.code(502).send({ outcome, status: "degraded" });
    return reply.code(200).send({ outcome, status: "connected", integrationId });
  });

  app.post<{
    Params: { merchantId: string; integrationId: string };
  }>("/api/v1/merchants/:merchantId/integrations/:integrationId/suspend", async (request, reply) => {
    const { merchantId, integrationId } = request.params;
    const result = await authorizeRequest(request, options, {
      resource: "merchant.integration", action: "update", scope: { merchantId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!["merchant_owner", "merchant_admin"].includes(result.actor.role)) {
      return reply.code(403).send({ error: "merchant_admin_only" });
    }
    if (!options.integrationHub) return reply.code(503).send({ error: "service_unavailable" });
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const outcome = await options.integrationHub.suspend(tenantId, integrationId, new Date().toISOString());
    if (outcome === "not_found") return reply.code(404).send({ error: "integration_not_found" });
    if (outcome === "invalid_transition") return reply.code(409).send({ error: "integration_cannot_be_suspended" });
    return reply.code(200).send({ outcome: "suspended", integrationId });
  });

  app.post<{
    Params: { merchantId: string };
    Body: {
      id: string;
      family: string;
      providerKey: string;
      displayName: string;
      capabilities: string[];
    };
  }>("/api/v1/merchants/:merchantId/integrations", async (request, reply) => {
    const { merchantId } = request.params;
    const result = await authorizeRequest(request, options, {
      resource: "merchant.integration", action: "create", scope: { merchantId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!["merchant_owner", "merchant_admin"].includes(result.actor.role)) {
      return reply.code(403).send({ error: "merchant_admin_only" });
    }
    if (!options.integrationHub) return reply.code(503).send({ error: "service_unavailable" });
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const body = request.body;
    if (!body || typeof body.id !== "string" || !/^[a-zA-Z0-9_-]{2,80}$/.test(body.id) ||
        typeof body.family !== "string" || !INTEGRATION_FAMILIES.includes(body.family as typeof INTEGRATION_FAMILIES[number]) ||
        typeof body.providerKey !== "string" || body.providerKey.trim().length < 1 || body.providerKey.trim().length > 100 ||
        typeof body.displayName !== "string" || body.displayName.trim().length < 2 || body.displayName.trim().length > 160 ||
        !Array.isArray(body.capabilities) || body.capabilities.length > 50 ||
        body.capabilities.some((item) => typeof item !== "string" || item.trim().length < 1 || item.length > 100)) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    // Hard-reservation authority is a platform-controlled security grant, not a
    // merchant-declared capability. It can only be provisioned through the trusted
    // integration approval process after provider verification and branch scoping.
    if (body.capabilities.includes("inventory.hard_reservation")) {
      return reply.code(403).send({ error: "capability_requires_platform_approval" });
    }
    const now = new Date().toISOString();
    try {
      await options.integrationHub.register({
        id: body.id,
        tenantId,
        family: body.family as typeof INTEGRATION_FAMILIES[number],
        providerKey: body.providerKey.trim(),
        displayName: body.displayName.trim(),
        status: "pending",
        capabilities: body.capabilities.map((item) => item.trim()),
        createdAtUtc: now,
        updatedAtUtc: now
      });
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_INTEGRATION_REGISTRATION") {
        return reply.code(400).send({ error: "invalid_request" });
      }
      if (error instanceof Error && error.message === "INTEGRATION_ALREADY_EXISTS") {
        return reply.code(409).send({ error: "integration_already_exists" });
      }
      throw error;
    }
    return reply.code(201).send({
      integration: {
        id: body.id, tenantId, family: body.family,
        providerKey: body.providerKey.trim(), displayName: body.displayName.trim(),
        status: "pending", capabilities: [...new Set(body.capabilities.map((item) => item.trim()))],
        createdAtUtc: now, updatedAtUtc: now
      }
    });
  });


  app.post<{
    Params: { merchantId: string; integrationId: string };
    Body: { sourceUrl?: unknown; cursor?: unknown; updatedSinceUtc?: unknown };
  }>("/api/v1/merchants/:merchantId/integrations/:integrationId/catalog/import", async (request, reply) => {
    const { merchantId, integrationId } = request.params;
    const result = await authorizeRequest(request, options, {
      resource: "merchant.integration", action: "create", scope: { merchantId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!["merchant_owner", "merchant_admin"].includes(result.actor.role)) {
      return reply.code(403).send({ error: "merchant_admin_only" });
    }
    if (!options.merchantCatalogImport) {
      return reply.code(503).send({ error: "catalog_import_provider_not_configured" });
    }
    const body = request.body;
    if (!body || typeof body.sourceUrl !== "string" || body.sourceUrl.length > 2000 ||
        (body.cursor !== undefined && (typeof body.cursor !== "string" || body.cursor.length > 2000)) ||
        (body.updatedSinceUtc !== undefined && (typeof body.updatedSinceUtc !== "string" ||
          !Number.isFinite(Date.parse(body.updatedSinceUtc)) || !body.updatedSinceUtc.endsWith("Z")))) {
      return reply.code(400).send({ error: "invalid_catalog_import_request" });
    }
    try {
      const tenantId = await options.resolveMerchantTenantId?.(merchantId);
      if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
      const summary = await options.merchantCatalogImport.import({
        tenantId, integrationId, sourceUrl: body.sourceUrl,
        ...(body.cursor === undefined ? {} : { cursor: body.cursor as string }),
        ...(body.updatedSinceUtc === undefined ? {} : { updatedSinceUtc: body.updatedSinceUtc as string })
      });
      return reply.code(200).send({ import: summary });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "CATALOG_INTEGRATION_NOT_FOUND") return reply.code(404).send({ error: "integration_not_found" });
      if (code === "CATALOG_INTEGRATION_NOT_CONNECTED") return reply.code(409).send({ error: "integration_not_connected" });
      if (code === "CATALOG_PROVIDER_NOT_CONFIGURED") return reply.code(503).send({ error: "catalog_provider_not_configured" });
      if (code === "CATALOG_INTEGRATION_FAMILY_UNSUPPORTED") return reply.code(409).send({ error: "integration_family_unsupported" });
      if (code === "CATALOG_CAPABILITY_NOT_GRANTED") return reply.code(409).send({ error: "catalog_read_capability_not_granted" });
      if (code === "SALLA_ACCESS_TOKEN_UNAVAILABLE") return reply.code(503).send({ error: "provider_credentials_unavailable" });
      if (code.startsWith("SALLA_")) return reply.code(502).send({ error: "catalog_provider_request_failed" });
      if (["UNTRUSTED_CATALOG_SOURCE", "INVALID_CATALOG_IMPORT_REQUEST", "INVALID_OR_REPEATED_CATALOG_CURSOR"].includes(code)) {
        return reply.code(400).send({ error: "invalid_or_untrusted_catalog_source" });
      }
      throw error;
    }
  });

  app.get<{
    Params: { merchantId: string; branchId: string };
    Querystring: { limit?: string };
  }>("/api/v1/catalog/merchants/:merchantId/branches/:branchId/products", async (request, reply) => {
    const { merchantId, branchId } = request.params;
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(merchantId) || !/^[a-zA-Z0-9._:-]{1,160}$/.test(branchId)) {
      return reply.code(400).send({ error: "invalid_catalog_scope" });
    }
    const rawLimit = request.query.limit;
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return reply.code(400).send({ error: "invalid_limit" });
    if (!options.merchantCatalog?.listPublishedBranchProducts) return reply.code(503).send({ error: "customer_catalog_unavailable" });
    const products = await options.merchantCatalog.listPublishedBranchProducts({ merchantId, branchId, limit });
    reply.header("cache-control", "no-store");
    return reply.code(200).send({ products });
  });

  app.get<{
    Params: { merchantId: string };
    Querystring: { limit?: string };
  }>("/api/v1/merchants/:merchantId/catalog/products", async (request, reply) => {
    const { merchantId } = request.params;
    const result = await authorizeRequest(request, options, {
      resource: "merchant.integration", action: "read", scope: { merchantId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!["merchant_owner", "merchant_admin"].includes(result.actor.role)) {
      return reply.code(403).send({ error: "merchant_admin_only" });
    }
    if (!options.merchantCatalog) return reply.code(503).send({ error: "catalog_service_unavailable" });
    const rawLimit = request.query.limit;
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return reply.code(400).send({ error: "invalid_limit" });
    }
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const products = await options.merchantCatalog.listProducts(tenantId, limit);
    return reply.code(200).send({ products });
  });

  app.post<{
    Params: { merchantId: string };
    Body: {
      integrationId: string; providerKey: string; externalProductId: string;
      canonicalUrl: string; title: string; description?: string; brand?: string;
      currency?: string; priceMinor?: number; imageUrls?: string[];
      sourceType: CatalogProductInput["sourceType"]; sourceCapturedAt: string;
      sourceContentSha256: string; sizeChartUrl?: string;
      variants?: CatalogProductInput["variants"];
    };
  }>("/api/v1/merchants/:merchantId/catalog/products", async (request, reply) => {
    const { merchantId } = request.params;
    const result = await authorizeRequest(request, options, {
      resource: "merchant.integration", action: "create", scope: { merchantId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (!["merchant_owner", "merchant_admin"].includes(result.actor.role)) {
      return reply.code(403).send({ error: "merchant_admin_only" });
    }
    if (!options.merchantCatalog) return reply.code(503).send({ error: "catalog_service_unavailable" });
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const body = request.body;
    const validText = (value: unknown, max: number) =>
      typeof value === "string" && value.trim().length > 0 && value.length <= max;
    const validMoney = (value: unknown) =>
      value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
    const variants = body?.variants ?? [];
    const validVariants = Array.isArray(variants) && variants.length <= 500 &&
      variants.every(variant => variant && validText(variant.externalVariantId, 200) &&
        (variant.sku === undefined || validText(variant.sku, 200)) &&
        (variant.barcode === undefined || validText(variant.barcode, 100)) &&
        (variant.sizeLabel === undefined || validText(variant.sizeLabel, 100)) &&
        (variant.colorLabel === undefined || validText(variant.colorLabel, 100)) &&
        (variant.currency === undefined || /^[A-Z]{3}$/.test(variant.currency)) &&
        validMoney(variant.priceMinor) &&
        (variant.availability === undefined || ["in_stock","out_of_stock","preorder","unknown"].includes(variant.availability)));
    const capturedAt = typeof body?.sourceCapturedAt === "string" ? Date.parse(body.sourceCapturedAt) : NaN;
    if (!body || !validText(body.integrationId, 100) ||
        !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(body.providerKey) ||
        !validText(body.externalProductId, 200) ||
        !validText(body.canonicalUrl, 2000) || !body.canonicalUrl.startsWith("https://") ||
        !validText(body.title, 500) ||
        (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 10000)) ||
        (body.brand !== undefined && !validText(body.brand, 200)) ||
        (body.currency !== undefined && !/^[A-Z]{3}$/.test(body.currency)) ||
        !validMoney(body.priceMinor) ||
        !Array.isArray(body.imageUrls ?? []) || (body.imageUrls ?? []).length > 30 ||
        (body.imageUrls ?? []).some(url => !validText(url, 2000) || !url.startsWith("https://")) ||
        !["official_api","merchant_feed","structured_data","html_page","manual"].includes(body.sourceType) ||
        !Number.isFinite(capturedAt) ||
        !/^[a-f0-9]{64}$/.test(body.sourceContentSha256) ||
        (body.sizeChartUrl !== undefined && (!validText(body.sizeChartUrl, 2000) || !body.sizeChartUrl.startsWith("https://"))) ||
        !validVariants) {
      return reply.code(400).send({ error: "invalid_catalog_product" });
    }
    try {
      const product = await options.merchantCatalog.createProduct({
        tenantId, integrationId: body.integrationId,
        providerKey: body.providerKey, externalProductId: body.externalProductId,
        canonicalUrl: body.canonicalUrl, title: body.title.trim(),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.brand === undefined ? {} : { brand: body.brand.trim() }),
        ...(body.currency === undefined ? {} : { currency: body.currency }),
        ...(body.priceMinor === undefined ? {} : { priceMinor: body.priceMinor }),
        imageUrls: body.imageUrls ?? [], sourceType: body.sourceType,
        sourceCapturedAt: new Date(capturedAt).toISOString(),
        sourceContentSha256: body.sourceContentSha256,
        ...(body.sizeChartUrl === undefined ? {} : { sizeChartUrl: body.sizeChartUrl }),
        variants
      });
      return reply.code(201).send({ product });
    } catch (error) {
      if (error instanceof Error && error.message === "CATALOG_INTEGRATION_NOT_CONNECTED") {
        return reply.code(409).send({ error: "catalog_integration_not_connected" });
      }
      if (error instanceof Error && error.message === "CATALOG_PRODUCT_ALREADY_EXISTS") {
        return reply.code(409).send({ error: "catalog_product_already_exists" });
      }
      throw error;
    }
  });


  app.get<{
    Params: { merchantId: string; branchId: string };
    Querystring: { limit?: string };
  }>("/api/v1/merchants/:merchantId/branches/:branchId/inventory", async (request, reply) => {
    const { merchantId, branchId } = request.params;
    const access = await authorizeRequest(request, options, {
      resource: "merchant.branch.inventory", action: "read", scope: { merchantId, branchId }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    const rawLimit = request.query.limit;
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return reply.code(400).send({ error: "invalid_limit" });
    }
    if (!options.branchInventoryReader) return reply.code(503).send({ error: "inventory_read_unavailable" });
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const inventory = await options.branchInventoryReader.list({ tenantId, merchantId, branchId, limit });
    return reply.code(200).send({ inventory });
  });

  app.get<{
    Params: { merchantId: string; branchId: string };
    Querystring: { limit?: string };
  }>("/api/v1/merchants/:merchantId/branches/:branchId/inventory/reconciliation-alerts", async (request, reply) => {
    const { merchantId, branchId } = request.params;
    const access = await authorizeRequest(request, options, {
      resource: "merchant.branch.inventory", action: "read", scope: { merchantId, branchId }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    const reader = options.branchInventoryReader;
    if (!reader?.listOpenReconciliationAlerts) {
      return reply.code(503).send({ error: "inventory_reconciliation_read_unavailable" });
    }
    const rawLimit = request.query.limit;
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return reply.code(400).send({ error: "invalid_limit" });
    }
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const alerts = await reader.listOpenReconciliationAlerts({ tenantId, merchantId, branchId, limit });
    return reply.code(200).send({ alerts });
  });

  app.put<{ Params: { merchantId: string; productId: string }; Body: { published: boolean } }>(
    "/api/v1/merchants/:merchantId/catalog/products/:productId/publication", async (request, reply) => {
      const { merchantId, productId } = request.params;
      const access = await authorizeRequest(request, options, {
        resource: "merchant.integration", action: "update", scope: { merchantId }
      });
      if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
      if (!["merchant_owner", "merchant_admin"].includes(access.actor.role)) return reply.code(403).send({ error: "merchant_admin_only" });
      if (!options.merchantCatalog?.setProductPublication) return reply.code(503).send({ error: "catalog_publication_unavailable" });
      if (!request.body || typeof request.body.published !== "boolean") return reply.code(400).send({ error: "invalid_publication_request" });
      const tenantId = await options.resolveMerchantTenantId?.(merchantId);
      if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
      const result = await options.merchantCatalog.setProductPublication({ tenantId, productId, published: request.body.published });
      if (result.outcome === "not_found") return reply.code(404).send({ error: "catalog_product_not_found" });
      if (options.auditEvents) await options.auditEvents.append(createAuditEvent({
        id: randomUUID(), type: "catalog.product.publication_changed", category: "catalog_governance",
        occurredAt: new Date().toISOString(), actor: { id: access.actor.id, type: "merchant_user", role: access.actor.role },
        action: request.body.published ? "catalog.product.publish" : "catalog.product.unpublish",
        outcome: "success", resourceType: "commerce_catalog_product", resourceId: productId,
        tenantId, merchantId, correlationId: request.id, source: "api", severity: "info",
        metadata: { published: request.body.published, publishedAt: result.publishedAt }
      }));
      return reply.code(200).send({ productId, published: request.body.published, publishedAt: result.publishedAt });
    });

  app.post<{
    Params: { merchantId: string; branchId: string };
    Body: { source: "pos" | "erp" | "ecommerce" | "csv" | "merchant_portal" | "manual"; capturedAtUtc: string;
      lines: Array<{ productVariantId: string; sku: string; availableQuantity: number }> };
  }>("/api/v1/merchants/:merchantId/branches/:branchId/inventory/sync", async (request, reply) => {
    const { merchantId, branchId } = request.params;
    const access = await authorizeRequest(request, options, {
      resource: "merchant.branch.inventory", action: "update", scope: { merchantId, branchId }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    if (!options.branchInventorySync) return reply.code(503).send({ error: "inventory_sync_unavailable" });
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const body = request.body;
    if (!body || !["pos","erp","ecommerce","csv","merchant_portal","manual"].includes(body.source) ||
        typeof body.capturedAtUtc !== "string" || !Array.isArray(body.lines) ||
        body.lines.length > 5000) {
      return reply.code(400).send({ error: "invalid_inventory_snapshot" });
    }
    try {
      const result = await options.branchInventorySync.sync({
        tenantId, merchantId, branchId, source: body.source,
        capturedAtUtc: body.capturedAtUtc, lines: body.lines
      });
      return reply.code(200).send({ result });
    } catch (error) {
      if (error instanceof Error && (error.message === "INVALID_BRANCH_INVENTORY_SNAPSHOT" ||
          error.message === "INVALID_BRANCH_INVENTORY_LINE" ||
          error.message === "FUTURE_BRANCH_INVENTORY_SNAPSHOT")) {
        return reply.code(400).send({ error: "invalid_inventory_snapshot" });
      }
      if (error instanceof Error && error.message === "BRANCH_INVENTORY_SCOPE_NOT_FOUND") {
        return reply.code(404).send({ error: "branch_not_found" });
      }
      if (error instanceof Error && error.message === "BRANCH_INVENTORY_RESERVED_STOCK_CONFLICT") {
        return reply.code(409).send({ error: "snapshot_conflicts_with_reserved_stock" });
      }
      throw error;
    }
  });


  app.post<{
    Params: { merchantId: string; branchId: string; reservationId: string };
    Body: { action: "release" | "expire" | "consume"; reason?: string; handoverVerified?: boolean; handoverReference?: string };
  }>("/api/v1/merchants/:merchantId/branches/:branchId/inventory/reservations/:reservationId/finalize", async (request, reply) => {
    const { merchantId, branchId, reservationId } = request.params;
    const access = await authorizeRequest(request, options, {
      resource: "merchant.branch.inventory_reservation", action: "execute", scope: { merchantId, branchId }
    });
    if (!access.actor) return sendAuthorizationFailure(reply, access.statusCode, access.decision.reason);
    const lifecycle = options.inventoryReservationLifecycle;
    if (!lifecycle) return reply.code(503).send({ error: "inventory_reservation_lifecycle_unavailable" });
    const tenantId = await options.resolveMerchantTenantId?.(merchantId);
    if (!tenantId) return reply.code(404).send({ error: "merchant_not_found" });
    const body = request.body;
    if (!body || !["release","expire","consume"].includes(body.action)) {
      return reply.code(400).send({ error: "invalid_reservation_action" });
    }
    // A client-supplied boolean/reference is not trusted proof of physical handover.
    // Consumption must be initiated by a verified fulfillment event, never this public route.
    if (body.action === "consume") {
      return reply.code(409).send({ error: "verified_fulfillment_event_required" });
    }
    try {
      const nowUtc = new Date().toISOString();
      const result = body.action === "release"
        ? await lifecycle.release({ tenantId, merchantId, branchId, reservationId, nowUtc, reason: body.reason ?? "" })
        : await lifecycle.expire({ tenantId, merchantId, branchId, reservationId, nowUtc });
      return reply.code(result.outcome === "not_found" ? 404 : 200).send({ result });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code.startsWith("inventory_reservation_")) return reply.code(409).send({ error: code });
      throw error;
    }
  });

  return app;
}
