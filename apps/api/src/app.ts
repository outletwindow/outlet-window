import { randomUUID } from "node:crypto";
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
  }): Promise<"created" | "already_exists" | "merchant_not_found" | "merchant_inactive">;
  updateBranch(input: { merchantId: string; branchId: string; displayName: string; cityCode: string; address?: Readonly<Record<string, unknown>>; status: "active" | "inactive" }): Promise<"updated" | "not_found" | "merchant_not_found" | "merchant_inactive">;
}

export interface CustomerDeliveryDestinationService {
  /** Must resolve the service area and a fresh quote server-side; never accept pricing/zone/branch from the client. */
  update(input: { customerId: string; orderId: string; actorId: string; destination: DeliveryCoordinate }): Promise<UpdateDeliveryDestinationResult>;
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
}

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
        (body.address !== undefined && (typeof body.address !== "object" || body.address === null || Array.isArray(body.address)))) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const created = await options.merchantBranchWriter.createBranch({
      merchantId: request.params.merchantId,
      branchId: body.branchId,
      displayName: body.displayName.trim(),
      cityCode: body.cityCode,
      ...(body.address === undefined ? {} : { address: body.address })
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
        (body.address !== undefined && (typeof body.address !== "object" || body.address === null || Array.isArray(body.address)))) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const updated = await options.merchantBranchWriter.updateBranch({
      merchantId: request.params.merchantId,
      branchId: request.params.branchId,
      displayName: body.displayName.trim(),
      cityCode: body.cityCode,
      status: body.status,
      ...(body.address === undefined ? {} : { address: body.address })
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
    if (updated.outcome === "not_found") return reply.code(404).send({ error: "not_found" });
    if (updated.outcome === "edit_window_expired") return reply.code(409).send({ error: "edit_window_expired" });
    if (updated.outcome === "fulfillment_already_started") return reply.code(409).send({ error: "fulfillment_already_started" });
    if (updated.outcome === "outside_service_area") return reply.code(422).send({ error: "outside_service_area" });
    if (updated.outcome === "invalid_destination") return reply.code(400).send({ error: "invalid_destination" });
    if (updated.outcome === "invalid_service_area" || updated.outcome === "invalid_quote") return reply.code(503).send({ error: "delivery_quote_unavailable" });
    if (updated.outcome === "version_conflict") return reply.code(409).send({ error: "version_conflict" });
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

  return app;
}
