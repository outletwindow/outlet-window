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
import type { CatalogProductInput, CatalogProductRecord } from "../../../packages/domain/src/postgres-merchant-catalog.js";
import type { MerchantCatalogImportService } from "../../../packages/domain/src/merchant-catalog-import-service.js";
import type { BranchInventorySyncRequest, BranchInventorySyncResult } from "../../../packages/domain/src/branch-inventory-sync.js";
import type { InventoryReservationFinalizeResult } from "../../../packages/domain/src/postgres-branch-inventory-reservation-lifecycle.js";

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
}

export interface CustomerPaymentAdjustmentActions {
  consent(input: { orderId: string; adjustmentId: string; customerId: string }): Promise<{ outcome: string }>;
  decline(input: { orderId: string; adjustmentId: string; customerId: string }): Promise<{ outcome: string }>;
}
export interface PaymentWebhookInboxWriter {
  record(input: { providerKey: string; providerEventId: string; rawBody: string; adjustmentId?: string; eventType?: string; normalizedStatus?: "succeeded" | "failed" | "ignored" | "unsupported"; providerReference?: string }): Promise<
    | { outcome: "received"; receiptId: string }
    | { outcome: "duplicate"; receiptId: string }
    | { outcome: "event_id_collision" }
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

export interface AppOptions {
  serviceName?: string;
  version?: string;
  /** Resolve an authenticated principal from a verified session; never trust client-supplied role headers. */
  resolveActor?: (request: FastifyRequest) => Promise<Actor | null>;
  /** Optional trusted persistence/crypto adapters for resolving real bearer sessions. */
  actorResolution?: ActorResolutionDependencies;
  /** Repository adapter must apply merchantId and branchId predicates in its database query. */
  merchantBranches?: MerchantBranchReader;
  merchantBranchWriter?: MerchantBranchWriter;
  /** Optional dependency check used by readiness; failures keep the instance out of service. */
  readinessCheck?: () => Promise<boolean>;
  /** Durable audit writer. Protected operations are not executed if their audit write fails. */
  auditEvents?: AuditEventWriter;
  orderTransitions?: OrderTransitionWriter;
  customerDeliveryDestinations?: CustomerDeliveryDestinationService;
  customerPaymentAdjustments?: CustomerPaymentAdjustmentActions;
  integrationHub?: IntegrationHub;
  merchantCatalog?: MerchantCatalogRepository;
  /** Resolve merchant tenant ownership from trusted persistence after authorization. */
  resolveMerchantTenantId?: (merchantId: string) => Promise<string | null>;
  merchantCatalogImport?: MerchantCatalogImportService;
  paymentWebhookInbox?: PaymentWebhookInboxWriter;
  paymentWebhookSecretResolver?: (providerKey: string) => Promise<string | null>;
  sallaOAuthFlow?: SallaOAuthFlow;
  branchInventorySync?: { sync(input: BranchInventorySyncRequest): Promise<BranchInventorySyncResult> };
  inventoryReservationLifecycle?: {
    release(input: { tenantId: string; reservationId: string; nowUtc: string; reason: string }): Promise<InventoryReservationFinalizeResult>;
    expire(input: { tenantId: string; reservationId: string; nowUtc: string }): Promise<InventoryReservationFinalizeResult>;
    consume(input: { tenantId: string; reservationId: string; nowUtc: string; handoverVerified: boolean; handoverReference: string }): Promise<InventoryReservationFinalizeResult>;
  };
}

const paymentWebhookRawBodies = new WeakMap<FastifyRequest, string>();

type AuthorizationResult =
  | { actor: Actor; decision: AuthorizationDecision & { allowed: true } }
  | { actor: null; decision: AuthorizationDecision & { allowed: false }; statusCode: 401 | 403 };

async function authorizeRequest(
  request: FastifyRequest,
  options: AppOptions,
  authorizationRequest: AuthorizationRequest
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

  const decision = authorize(actor, authorizationRequest);
  if (options.auditEvents) {
    const merchantId = authorizationRequest.scope.merchantId;
    await options.auditEvents.append(createAuditEvent({
      id: randomUUID(),
      type: decision.allowed ? `authorization.${authorizationRequest.action}.granted` : `authorization.${authorizationRequest.action}.denied`,
      category: "access_control",
      occurredAt: new Date().toISOString(),
      actor: { id: actor.id, type: actor.role === "merchant_owner" || actor.role === "merchant_admin" ||
        actor.role === "branch_manager" || actor.role === "merchant_employee" ? "merchant_user" :
        actor.role === "customer" ? "customer" : actor.role === "shopper" ? "shopper" :
        actor.role === "courier" ? "courier" : actor.role === "ai_agent" ? "ai_agent" : "platform_user",
        role: actor.role },
      action: `${authorizationRequest.resource}:${authorizationRequest.action}`,
      outcome: decision.allowed ? "success" : "denied",
      resourceType: authorizationRequest.resource,
      ...(authorizationRequest.scope.branchId ? { resourceId: authorizationRequest.scope.branchId, branchId: authorizationRequest.scope.branchId } : {}),
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
    if (!options.paymentWebhookInbox || !options.paymentWebhookSecretResolver) {
      return reply.code(503).send({ error: "webhook_service_unavailable" });
    }
    const rawBody = paymentWebhookRawBodies.get(request);
    if (rawBody === undefined || !rawBody.length) {
      return reply.code(400).send({ error: "empty_webhook_body" });
    }
    const signatureHeader = request.headers["x-payment-signature"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    const secret = await options.paymentWebhookSecretResolver(providerKey);
    if (!secret) return reply.code(503).send({ error: "webhook_provider_not_configured" });
    if (!verifyPaymentProviderWebhook({ rawBody, signatureHeader: signature, secret })) {
      return reply.code(401).send({ error: "invalid_webhook_signature" });
    }
    const body = request.body;
    if (typeof body !== "object" || body === null ||
        typeof (body as { id?: unknown }).id !== "string" ||
        !(body as { id: string }).id.trim() ||
        (body as { id: string }).id.length > 240) {
      return reply.code(400).send({ error: "invalid_webhook_event" });
    }
    const eventType = (body as { type?: unknown }).type;
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

  // Authentication and authorization always precede adapter availability checks and data access.
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
      tenantId: merchantId, merchantId, branchId, correlationId: request.id,
      source: "api", severity: "info",
      metadata: { orderId, nextStatus: body.nextStatus, expectedVersion: body.expectedVersion }
    });
    const persisted = await options.orderTransitions.transitionSuborder({
      tenantId: merchantId, orderId, suborderId, nextStatus: body.nextStatus, context, auditEvent
    });
    if (persisted.outcome === "not_found") return reply.code(404).send({ error: "not_found" });
    if (persisted.outcome === "conflict") return reply.code(409).send({ error: "version_conflict" });
    if (persisted.outcome === "rejected") return reply.code(409).send({ error: persisted.reason });
    return reply.code(200).send({
      suborder: { id: suborderId, status: persisted.transition.order.status, version: persisted.transition.order.version },
      previousStatus: persisted.transition.previousStatus, parentStatus: persisted.parentStatus
    });
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

  app.post<{
    Params: { orderId: string; adjustmentId: string };
  }>("/api/v1/customer/orders/:orderId/payment-adjustments/:adjustmentId/consent", async (request, reply) => {
    const result = await authorizeRequest(request, options, {
      resource: "customer.order", action: "update", scope: { orderId: request.params.orderId }
    });
    if (!result.actor) return sendAuthorizationFailure(reply, result.statusCode, result.decision.reason);
    if (result.actor.role !== "customer") return reply.code(403).send({ error: "customer_only" });
    if (!options.customerPaymentAdjustments) return reply.code(503).send({ error: "service_unavailable" });
    const outcome = await options.customerPaymentAdjustments.consent({
      orderId: request.params.orderId, adjustmentId: request.params.adjustmentId,
      customerId: result.actor.id
    });
    if (outcome.outcome === "not_found") return reply.code(404).send({ error: "not_found" });
    if (outcome.outcome === "expired") return reply.code(410).send({ error: "adjustment_expired" });
    if (outcome.outcome !== "consented") return reply.code(409).send({ error: "adjustment_not_pending" });
    return reply.code(200).send({ outcome: "consented", message: "Customer consent recorded; payment processing is not yet confirmed." });
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
    const integration = await options.integrationHub?.get(merchantId, integrationId);
    if (!integration) return reply.code(404).send({ error: "integration_not_found" });
    if (integration.providerKey !== "salla" || integration.family !== "commerce") {
      return reply.code(409).send({ error: "integration_provider_mismatch" });
    }
    if (integration.status !== "pending") {
      return reply.code(409).send({ error: "integration_must_be_pending_before_authorization" });
    }
    const started = await options.sallaOAuthFlow.begin({ tenantId: merchantId, integrationId });
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
    const family = request.query.family;
    if (family !== undefined && !INTEGRATION_FAMILIES.includes(family as typeof INTEGRATION_FAMILIES[number])) {
      return reply.code(400).send({ error: "invalid_integration_family" });
    }
    const integrations = await options.integrationHub.list(
      merchantId, family as typeof INTEGRATION_FAMILIES[number] | undefined
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
    const body = request.body;
    if (!body || typeof body.secretReference !== "string") {
      return reply.code(400).send({ error: "invalid_secret_reference" });
    }
    const outcome = await options.integrationHub.rotateSecretReference(
      merchantId, integrationId, body.secretReference, new Date().toISOString()
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
    const outcome = await options.integrationHub.reconnect(merchantId, integrationId, new Date().toISOString());
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
    const outcome = await options.integrationHub.verifyConnection(
      merchantId, integrationId, new Date().toISOString()
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
    const outcome = await options.integrationHub.suspend(merchantId, integrationId, new Date().toISOString());
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
    const body = request.body;
    if (!body || typeof body.id !== "string" || !/^[a-zA-Z0-9_-]{2,80}$/.test(body.id) ||
        typeof body.family !== "string" || !INTEGRATION_FAMILIES.includes(body.family as typeof INTEGRATION_FAMILIES[number]) ||
        typeof body.providerKey !== "string" || body.providerKey.trim().length < 1 || body.providerKey.trim().length > 100 ||
        typeof body.displayName !== "string" || body.displayName.trim().length < 2 || body.displayName.trim().length > 160 ||
        !Array.isArray(body.capabilities) || body.capabilities.length > 50 ||
        body.capabilities.some((item) => typeof item !== "string" || item.trim().length < 1 || item.length > 100)) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const now = new Date().toISOString();
    try {
      await options.integrationHub.register({
        id: body.id,
        tenantId: merchantId,
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
        id: body.id, tenantId: merchantId, family: body.family,
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
      const summary = await options.merchantCatalogImport.import({
        tenantId: merchantId, integrationId, sourceUrl: body.sourceUrl,
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
        body.lines.length < 1 || body.lines.length > 5000) {
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
          error.message === "INVALID_BRANCH_INVENTORY_LINE")) {
        return reply.code(400).send({ error: "invalid_inventory_snapshot" });
      }
      if (error instanceof Error && error.message === "BRANCH_INVENTORY_SCOPE_NOT_FOUND") {
        return reply.code(404).send({ error: "branch_not_found" });
      }
      throw error;
    }
  });


  app.post<{
    Params: { merchantId: string; reservationId: string };
    Body: { action: "release" | "expire" | "consume"; reason?: string; handoverVerified?: boolean; handoverReference?: string };
  }>("/api/v1/merchants/:merchantId/inventory/reservations/:reservationId/finalize", async (request, reply) => {
    const { merchantId, reservationId } = request.params;
    const access = await authorizeRequest(request, options, {
      resource: "merchant.branch.inventory_reservation", action: "execute", scope: { merchantId }
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
        ? await lifecycle.release({ tenantId, reservationId, nowUtc, reason: body.reason ?? "" })
        : await lifecycle.expire({ tenantId, reservationId, nowUtc });
      return reply.code(result.outcome === "not_found" ? 404 : 200).send({ result });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code.startsWith("inventory_reservation_")) return reply.code(409).send({ error: code });
      throw error;
    }
  });

  return app;
}
