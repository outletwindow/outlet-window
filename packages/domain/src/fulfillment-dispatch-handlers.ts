import type { ScheduledFulfillmentTaskEnvelope } from "./scheduled-fulfillment-workflow.js";
import {
  ScheduledTaskConsumeError,
  type ScheduledTaskConsumer,
  type ScheduledTaskConsumerHandlers
} from "./scheduled-task-inbox.js";

export type FulfillmentDispatchTaskType =
  "merchant_preparation" | "shopper_collection" | "courier_dispatch";

export interface FulfillmentDispatchCommand {
  taskType: FulfillmentDispatchTaskType;
  orderId: string;
  tenantId: string;
  suborderId: string;
  merchantId: string;
  branchId: string;
  idempotencyKey: string;
  executeAtUtc: string;
}

/**
 * A real provider must durably accept the command using the idempotency key
 * before returning accepted. Never report accepted for a simulated/no-op send.
 */
export interface FulfillmentDispatchProvider {
  dispatch(command: FulfillmentDispatchCommand): Promise<
    | { status: "accepted"; providerReference: string }
    | { status: "retry"; code: string }
    | { status: "rejected"; code: string }
  >;
}

function safeProviderCode(code: string): string {
  return /^[A-Za-z0-9_.:-]{1,60}$/.test(code) ? code : "INVALID_PROVIDER_ERROR";
}

/**
 * Only explicitly configured provider handlers are exposed. No provider means
 * no handler; callers must not start consuming that task type until configured.
 */
export function createFulfillmentDispatchHandlers(
  providers: Partial<Record<FulfillmentDispatchTaskType, FulfillmentDispatchProvider>>
): ScheduledTaskConsumerHandlers {
  const handlers: ScheduledTaskConsumerHandlers = {};
  for (const taskType of ["merchant_preparation", "shopper_collection", "courier_dispatch"] as const) {
    const provider = providers[taskType];
    if (!provider) continue;
    const consumer: ScheduledTaskConsumer = {
      async handle(task: ScheduledFulfillmentTaskEnvelope, idempotencyKey: string): Promise<void> {
        if (task.taskType !== taskType || !task.target ||
            task.idempotencyKey !== idempotencyKey || !idempotencyKey.trim() ||
            !task.orderId.trim() || task.plan.orderId !== task.orderId ||
            !task.target.merchantTenantId.trim() || !task.target.suborderId.trim() ||
            !task.target.merchantId.trim() || !task.target.branchId.trim() ||
            !Number.isFinite(Date.parse(task.executeAtUtc))) {
          throw new ScheduledTaskConsumeError("INVALID_DISPATCH_COMMAND", false);
        }
        const result = await provider.dispatch({
          taskType, orderId: task.orderId,
          tenantId: task.target.merchantTenantId,
          suborderId: task.target.suborderId,
          merchantId: task.target.merchantId,
          branchId: task.target.branchId,
          idempotencyKey,
          executeAtUtc: task.executeAtUtc
        });
        if (result.status === "accepted") {
          if (!result.providerReference?.trim()) {
            throw new ScheduledTaskConsumeError("MISSING_PROVIDER_REFERENCE");
          }
          return;
        }
        if (result.status === "retry") {
          throw new ScheduledTaskConsumeError(safeProviderCode(result.code));
        }
        if (result.status === "rejected") {
          throw new ScheduledTaskConsumeError(safeProviderCode(result.code), false);
        }
        throw new ScheduledTaskConsumeError("INVALID_PROVIDER_RESPONSE");
      }
    };
    handlers[taskType] = consumer;
  }
  return handlers;
}
