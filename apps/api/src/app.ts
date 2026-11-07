import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  authorize,
  type Actor,
  type AuthorizationDecision,
  type AuthorizationRequest
} from "../../../packages/domain/src/authorization.js";
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

export interface AppOptions {
  serviceName?: string;
  version?: string;
  /** Resolve an authenticated principal from a verified session; never trust client-supplied role headers. */
  resolveActor?: (request: FastifyRequest) => Promise<Actor | null>;
  /** Optional trusted persistence/crypto adapters for resolving real bearer sessions. */
  actorResolution?: ActorResolutionDependencies;
  /** Repository adapter must apply merchantId and branchId predicates in its database query. */
  merchantBranches?: MerchantBranchReader;
  /** Optional dependency check used by readiness; failures keep the instance out of service. */
  readinessCheck?: () => Promise<boolean>;
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

  return app;
}
