import { describe, expect, it, vi } from "vitest";
import { createFulfillmentDispatchHandlers } from "./fulfillment-dispatch-handlers.js";
import { ScheduledTaskConsumeError } from "./scheduled-task-inbox.js";
import type { ScheduledFulfillmentTaskEnvelope } from "./scheduled-fulfillment-workflow.js";

const task: ScheduledFulfillmentTaskEnvelope = {
  taskType: "merchant_preparation",
  orderId: "order-1",
  idempotencyKey: "scheduled:order-1:suborder-1:v1",
  executeAtUtc: "2026-11-08T12:00:00.000Z",
  target: {
    merchantTenantId: "tenant-1", suborderId: "suborder-1",
    merchantId: "merchant-1", branchId: "branch-1"
  },
  plan: {
    orderId: "order-1",
    fulfillmentType: "home_delivery",
    scheduledFor: "2026-11-08T15:00:00+03:00",
    scheduledForUtc: "2026-11-08T12:00:00.000Z",
    paymentDueAt: "2026-11-08T09:00:00.000Z",
    inventoryReservationDueAt: "2026-11-08T09:00:00.000Z",
    preparationReleaseAtUtc: "2026-11-08T11:00:00.000Z",
    courierDispatchAtUtc: "2026-11-08T11:30:00.000Z",
    estimate: { preparationMinutes: 30, bufferMinutes: 0, travelMinutes: 30 },
    createdAt: "2026-11-08T09:00:00.000Z"
  }
};

describe("fulfillment provider dispatch handlers", () => {
  it("does not register handlers without a configured provider", () => {
    expect(createFulfillmentDispatchHandlers({})).toEqual({});
  });

  it("passes scoped command and idempotency key to configured provider", async () => {
    const dispatch = vi.fn(async () => ({ status: "accepted" as const, providerReference: "provider-task-1" }));
    const handlers = createFulfillmentDispatchHandlers({ merchant_preparation: { dispatch } });
    await handlers.merchant_preparation!.handle(task, task.idempotencyKey);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      taskType: "merchant_preparation", orderId: "order-1",
      tenantId: "tenant-1", suborderId: "suborder-1",
      merchantId: "merchant-1", branchId: "branch-1",
      idempotencyKey: task.idempotencyKey, executeAtUtc: task.executeAtUtc
    });
    expect(handlers.courier_dispatch).toBeUndefined();
  });

  it("fails permanently on a provider rejection", async () => {
    const handlers = createFulfillmentDispatchHandlers({
      merchant_preparation: { dispatch: async () => ({ status: "rejected", code: "BRANCH_DISABLED" }) }
    });
    await expect(handlers.merchant_preparation!.handle(task, task.idempotencyKey))
      .rejects.toMatchObject({ code: "BRANCH_DISABLED", retryable: false });
  });

  it("retries transient errors and missing provider acknowledgements", async () => {
    const retry = createFulfillmentDispatchHandlers({
      merchant_preparation: { dispatch: async () => ({ status: "retry", code: "PROVIDER_TIMEOUT" }) }
    });
    await expect(retry.merchant_preparation!.handle(task, task.idempotencyKey))
      .rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true });
    const missing = createFulfillmentDispatchHandlers({
      merchant_preparation: { dispatch: async () => ({ status: "accepted", providerReference: "" }) }
    });
    await expect(missing.merchant_preparation!.handle(task, task.idempotencyKey))
      .rejects.toMatchObject({ code: "MISSING_PROVIDER_REFERENCE", retryable: true });
  });

  it("never invokes a provider with mismatched or missing branch identity", async () => {
    const dispatch = vi.fn(async () => ({ status: "accepted" as const, providerReference: "provider-task-1" }));
    const handlers = createFulfillmentDispatchHandlers({ merchant_preparation: { dispatch } });
    await expect(handlers.merchant_preparation!.handle({
      ...task, target: { ...task.target!, branchId: "" }
    }, task.idempotencyKey)).rejects.toBeInstanceOf(ScheduledTaskConsumeError);
    await expect(handlers.merchant_preparation!.handle(task, "other-key"))
      .rejects.toMatchObject({ retryable: false });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
