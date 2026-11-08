import type { PostgresQueryable } from "./postgres-iam-store.js";
import type { ScheduledFulfillmentTaskEnvelope } from "./scheduled-fulfillment-workflow.js";

export interface FulfillmentProviderReceipt {
  inboxId: string;
  tenantId: string;
  orderId: string;
  suborderId: string;
  merchantTenantId: string;
  merchantId: string;
  branchId: string;
  taskType: ScheduledFulfillmentTaskEnvelope["taskType"];
  providerReference: string;
  acceptedAtUtc: string;
}

type ReceiptRow = {
  id: string;
  tenant_id: string;
  order_id: string;
  task_type: ScheduledFulfillmentTaskEnvelope["taskType"];
  provider_reference: string;
  processed_at: Date | string;
  suborder_id: string;
  merchant_tenant_id: string;
  merchant_id: string;
  branch_id: string;
};

function requireIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error("invalid_" + field);
  }
}

/**
 * Internal read port for provider acknowledgements. It deliberately scopes every
 * lookup by platform tenant and order; callers must authorize those identifiers
 * before invoking it. It does not expose provider receipts as customer tracking.
 */
export class PostgresFulfillmentReceiptReader {
  constructor(private readonly db: PostgresQueryable) {}

  async listForOrder(input: {
    tenantId: string;
    orderId: string;
    suborderId?: string;
  }): Promise<readonly FulfillmentProviderReceipt[]> {
    requireIdentifier(input.tenantId, "tenant_id");
    requireIdentifier(input.orderId, "order_id");
    if (input.suborderId !== undefined) requireIdentifier(input.suborderId, "suborder_id");

    const result = await this.db.query<ReceiptRow>(
      `SELECT id, tenant_id, order_id, task_type, provider_reference, processed_at,
              payload #>> '{target,suborderId}' AS suborder_id,
              payload #>> '{target,merchantTenantId}' AS merchant_tenant_id,
              payload #>> '{target,merchantId}' AS merchant_id,
              payload #>> '{target,branchId}' AS branch_id
       FROM scheduled_task_inbox
       WHERE tenant_id = $1
         AND order_id = $2
         AND status = 'completed'
         AND provider_reference IS NOT NULL
         AND ($3::text IS NULL OR payload #>> '{target,suborderId}' = $3)
       ORDER BY processed_at ASC, id ASC`,
      [input.tenantId, input.orderId, input.suborderId ?? null]
    );

    return result.rows.map(row => {
      if (!row.suborder_id || !row.merchant_tenant_id || !row.merchant_id || !row.branch_id ||
          !row.provider_reference.trim() || !row.processed_at) {
        throw new Error("invalid_fulfillment_receipt_row");
      }
      return {
        inboxId: row.id,
        tenantId: row.tenant_id,
        orderId: row.order_id,
        suborderId: row.suborder_id,
        merchantTenantId: row.merchant_tenant_id,
        merchantId: row.merchant_id,
        branchId: row.branch_id,
        taskType: row.task_type,
        providerReference: row.provider_reference,
        acceptedAtUtc: new Date(row.processed_at).toISOString()
      };
    });
  }
}
