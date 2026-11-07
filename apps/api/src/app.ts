import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { authorize, type Actor, type AuthorizationRequest } from "../../../packages/domain/src/authorization.js";

export interface AppOptions {
  serviceName?: string;
  version?: string;
  /** Resolve an authenticated principal from a verified session; never trust client-supplied role headers. */
  resolveActor?: (request: FastifyRequest) => Promise<Actor | null>;
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
    const actor = await options.resolveActor?.(request) ?? null;
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

  return app;
}
