import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { authorize, type Actor, type AuthorizationRequest } from "../../../packages/domain/src/authorization.js";
import { resolveActorFromBearerToken, type ActorResolutionDependencies } from "../../../packages/domain/src/actor-resolution.js";

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

  app.get("/ready", async (_request, reply) => reply.code(200).send({
    status: "ready",
    checks: { process: "ok" }
  }));

  app.get("/api/v1", async () => ({
    name: "Outlet Window API",
    version: "v1",
    status: "foundation"
  }));

  // Protected reference route: the actor must come from a verified server-side session.
  app.get<{
    Params: { merchantId: string; branchId: string };
  }>("/api/v1/merchants/:merchantId/branches/:branchId/access-check", async (request, reply) => {
    let actor: Actor | null = null;
    if (options.actorResolution) {
      const authorizationHeader = request.headers.authorization;
      const resolved = await resolveActorFromBearerToken({
        authorizationHeader: Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader,
        dependencies: options.actorResolution
      });
      actor = resolved.actor;
    } else {
      actor = await options.resolveActor?.(request) ?? null;
    }
    if (!actor) return reply.code(401).send({ error: "unauthenticated" });

    const authorizationRequest: AuthorizationRequest = {
      resource: "merchant.branch",
      action: "read",
      scope: {
        merchantId: request.params.merchantId,
        branchId: request.params.branchId
      }
    };
    const decision = authorize(actor, authorizationRequest);
    if (!decision.allowed) {
      return reply.code(403).send({ error: "forbidden", reason: decision.reason });
    }
    return reply.code(200).send({ access: "granted" });
  });


  // Example business-data route. Authorization is checked before repository access.
  app.get<{
    Params: { merchantId: string; branchId: string };
  }>("/api/v1/merchants/:merchantId/branches/:branchId/summary", async (request, reply) => {
    if (!options.merchantBranches) return reply.code(503).send({ error: "service_unavailable" });
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
    if (!actor) return reply.code(401).send({ error: "unauthenticated" });
    const decision = authorize(actor, {
      resource: "merchant.branch",
      action: "read",
      scope: { merchantId: request.params.merchantId, branchId: request.params.branchId }
    });
    if (!decision.allowed) return reply.code(403).send({ error: "forbidden", reason: decision.reason });
    const branch = await options.merchantBranches.findBranchSummary({
      merchantId: request.params.merchantId,
      branchId: request.params.branchId
    });
    if (!branch) return reply.code(404).send({ error: "not_found" });
    return reply.code(200).send({ branch });
  });

  return app;
}
