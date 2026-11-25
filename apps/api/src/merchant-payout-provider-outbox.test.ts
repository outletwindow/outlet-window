import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Actor } from "../../../packages/domain/src/authorization.js";
import { buildApp } from "./app.js";

describe("merchant payout provider submission API", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

  const finance: Actor = {
    id: "finance-user",role: "finance",active: true,
    grants: [{
      resource: "platform.merchant_settlement",actions: ["approve"],
      scope: {platform: true}
    }]
  };

  it("queues only a finance-authorized payout and never claims money moved", async () => {
    const enqueue = vi.fn(async () => ({outcome:"queued" as const,outboxId:"payout-outbox-1"}));
    const app = buildApp({
      resolveActor: async () => finance,
      merchantPayoutProviderOutbox: {enqueue}
    });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method:"POST",
      url:"/api/v1/platform/payout-authorization-requests/intent-1/provider-submission",
      payload:{destinationId:"destination-1",providerKey:"sandbox-provider",idempotencyKey:"payout-submit-key-1"}
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      outcome:"queued",outboxId:"payout-outbox-1",moneyTransferred:false
    });
    expect(enqueue).toHaveBeenCalledWith({
      payoutIntentId:"intent-1",destinationId:"destination-1",
      providerKey:"sandbox-provider",idempotencyKey:"payout-submit-key-1",actorId:"finance-user"
    });
  });

  it("rejects a non-finance actor even when the permission grant exists", async () => {
    const operations: Actor = {...finance,id:"ops-user",role:"operations",roles:["operations"]};
    const enqueue = vi.fn();
    const app = buildApp({
      resolveActor: async () => operations,
      merchantPayoutProviderOutbox: {enqueue}
    });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method:"POST",
      url:"/api/v1/platform/payout-authorization-requests/intent-1/provider-submission",
      payload:{destinationId:"destination-1",providerKey:"sandbox-provider",idempotencyKey:"payout-submit-key-1"}
    });
    expect(response.statusCode).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
