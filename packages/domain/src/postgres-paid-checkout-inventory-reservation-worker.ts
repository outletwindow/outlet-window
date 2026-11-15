import { randomUUID } from "node:crypto";
import { createAuditEvent } from "./audit.js";
import {
  reserveInventoryForPaidOrder,
  type InventoryReservationPort
} from "./inventory-reservation.js";
import type { PostgresPool } from "./postgres-iam-store.js";
import { PostgresOrderTransitionStore } from "./postgres-order-transition-store.js";
import {
  PostgresCheckoutRecoveryCaseStore,
  type CheckoutRecoveryFailureCode
} from "./postgres-checkout-recovery-case-store.js";

type ReservationJobRow = {
  id: string; tenant_id: string; order_id: string; capture_id: string; attempt_count: number;
};
type PaidOrderRow = {
  tenant_id: string; status: string; total_minor: string | number; currency: string;
  provider_payment_reference: string; captured_at: Date | string;
  capture_amount_minor: string | number; capture_currency: string;
};
type SuborderRow = {
  id: string; tenant_id: string; merchant_id: string; branch_id: string;
  status: string; version: number;
};
type OrderLineRow = { product_variant_id: string; sku: string; quantity: number };

export type PaidCheckoutReservationWorkerResult =
  | { outcome: "idle" }
  | { outcome: "completed" | "needs_review" | "retry_scheduled" | "dead_lettered" | "lease_lost";
      jobId: string; orderId: string; failureCode?: string };

export interface PaidCheckoutReservationWorkerOptions {
  workerId: string;
  leaseSeconds?: number;
  maxAttempts?: number;
  now?: () => Date;
  createId?: () => string;
}

/**
 * Consumes the transactional outbox created with a verified payment capture.
 * Reservation and order transition operations are independently idempotent:
 * a worker crash between them is safe to retry, and confirmation still rechecks
 * immutable capture evidence plus a live branch reservation in the transition store.
 */
export class PostgresPaidCheckoutInventoryReservationWorker {
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly pool: PostgresPool,
    private readonly inventory: InventoryReservationPort,
    private readonly transitions: Pick<PostgresOrderTransitionStore, "transitionSuborder">,
    private readonly recovery: Pick<PostgresCheckoutRecoveryCaseStore, "record">,
    private readonly options: PaidCheckoutReservationWorkerOptions
  ) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(options.workerId)) {
      throw new Error("INVALID_PAID_CHECKOUT_RESERVATION_WORKER_ID");
    }
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.maxAttempts = options.maxAttempts ?? 12;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    if (!Number.isSafeInteger(this.leaseSeconds) || this.leaseSeconds < 5 || this.leaseSeconds > 300 ||
        !Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 30) {
      throw new Error("INVALID_PAID_CHECKOUT_RESERVATION_WORKER_CONFIGURATION");
    }
  }

  async runOnce(): Promise<PaidCheckoutReservationWorkerResult> {
    const nowUtc = this.now().toISOString();
    const claimed = await this.pool.query<ReservationJobRow>(
      `WITH due AS (
         SELECT id FROM paid_checkout_inventory_reservation_jobs
         WHERE (status = 'pending' AND next_attempt_at <= $1)
            OR (status = 'processing' AND lease_expires_at <= $1)
         ORDER BY COALESCE(lease_expires_at, next_attempt_at), created_at, id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE paid_checkout_inventory_reservation_jobs job
       SET status = 'processing', attempt_count = job.attempt_count + 1,
           lease_owner = $2, lease_expires_at = $1 + ($3::integer * interval '1 second'),
           updated_at = $1
       FROM due WHERE job.id = due.id
       RETURNING job.id,job.tenant_id,job.order_id,job.capture_id,job.attempt_count`,
      [nowUtc, this.options.workerId, this.leaseSeconds]
    );
    const job = claimed.rows[0];
    if (!job) return { outcome: "idle" };

    try {
      const result = await this.process(job);
      const status = result.needsReview ? "needs_review" : "completed";
      const updated = await this.pool.query(
        `UPDATE paid_checkout_inventory_reservation_jobs
         SET status=$4, failure_code=$5, lease_owner=NULL, lease_expires_at=NULL, updated_at=$3
         WHERE id=$1 AND status='processing' AND lease_owner=$2 AND lease_expires_at>$3`,
        [job.id, this.options.workerId, this.now().toISOString(), status, result.failureCode ?? null]
      );
      if (updated.rowCount !== 1) return { outcome: "lease_lost", jobId: job.id, orderId: job.order_id };
      return result.needsReview
        ? { outcome: "needs_review", jobId: job.id, orderId: job.order_id, failureCode: result.failureCode ?? "PAID_CHECKOUT_REQUIRES_REVIEW" }
        : { outcome: "completed", jobId: job.id, orderId: job.order_id };
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)
        ? error.message : "PAID_CHECKOUT_RESERVATION_RETRY";
      const delaySeconds = Math.min(1800, 5 * 2 ** Math.min(Math.max(job.attempt_count - 1, 0), 8));
      const retry = await this.pool.query(
        `UPDATE paid_checkout_inventory_reservation_jobs
         SET status=CASE WHEN attempt_count >= $5 THEN 'needs_review' ELSE 'pending' END,
             next_attempt_at=$3 + ($4::integer * interval '1 second'),
             failure_code=$6, lease_owner=NULL, lease_expires_at=NULL, updated_at=$3
         WHERE id=$1 AND status='processing' AND lease_owner=$2 AND lease_expires_at>$3`,
        [job.id, this.options.workerId, this.now().toISOString(), delaySeconds, this.maxAttempts, code]
      );
      if (retry.rowCount !== 1) return { outcome: "lease_lost", jobId: job.id, orderId: job.order_id };
      return job.attempt_count >= this.maxAttempts
        ? { outcome: "dead_lettered", jobId: job.id, orderId: job.order_id, failureCode: code }
        : { outcome: "retry_scheduled", jobId: job.id, orderId: job.order_id, failureCode: code };
    }
  }

  private async process(job: ReservationJobRow): Promise<{ needsReview: boolean; failureCode?: string }> {
    const paid = await this.pool.query<PaidOrderRow>(
      `SELECT o.tenant_id,o.status,o.total_minor,o.currency,
              p.provider_payment_reference,p.captured_at,p.amount_minor AS capture_amount_minor,
              p.currency AS capture_currency
       FROM customer_orders o
       JOIN verified_order_payment_captures p
         ON p.tenant_id=o.tenant_id AND p.order_id=o.id
       WHERE o.id=$1 AND p.id=$2 AND p.tenant_id=$3`,
      [job.order_id, job.capture_id, job.tenant_id]
    );
    const payment = paid.rows[0];
    if (paid.rows.length !== 1 || !payment ||
        Number(payment.total_minor) !== Number(payment.capture_amount_minor) ||
        payment.currency !== payment.capture_currency) {
      throw new Error("PAID_CHECKOUT_CAPTURE_EVIDENCE_MISMATCH");
    }

    const suborders = await this.pool.query<SuborderRow>(
      `SELECT s.id,s.tenant_id,s.merchant_id,s.branch_id,s.status,s.version
       FROM merchant_suborders s
       JOIN customer_orders o ON o.id=s.order_id AND o.tenant_id=$2
       WHERE s.order_id=$1 ORDER BY s.id`,
      [job.order_id, job.tenant_id]
    );
    if (suborders.rows.length === 0) {
      await this.recordRecovery(job, payment, "TASK_COMMIT_REJECTED", undefined, []);
      return { needsReview: true, failureCode: "ORDER_SUBORDERS_MISSING" };
    }
    const orderedSuborders = suborders.rows;
    if (orderedSuborders.some(row => !["pending_validation", "awaiting_payment", "confirmed"].includes(row.status))) {
      const failed = orderedSuborders.find(row => !["pending_validation", "awaiting_payment", "confirmed"].includes(row.status));
      await this.recordRecovery(job, payment, "TASK_COMMIT_REJECTED", failed?.id, []);
      return { needsReview: true, failureCode: "SUBORDER_STATUS_NOT_RESERVABLE" };
    }
    // Once one suborder is confirmed, the aggregate parent status becomes "preparing"
    // even while sibling suborders remain payable. The verified capture remains the
    // authority; accept that aggregate state for the remaining suborders.
    if (!["awaiting_payment", "preparing"].includes(payment.status) &&
        !orderedSuborders.every(row => row.status === "confirmed")) {
      await this.recordRecovery(job, payment, "TASK_COMMIT_REJECTED", undefined, []);
      return { needsReview: true, failureCode: "ORDER_STATUS_NOT_PAYABLE" };
    }
    if (orderedSuborders.every(row => row.status === "confirmed")) return { needsReview: false };

    // Reserve every branch first. No suborder is confirmed until all branch holds
    // have succeeded, so an unavailable later branch cannot leave a partially
    // fulfilled paid order without a durable recovery record for earlier holds.
    const reservations: Array<{
      suborder: SuborderRow;
      request: import("./inventory-reservation.js").InventoryReservationRequest;
      reservationReference: string;
    }> = [];
    for (const suborder of orderedSuborders) {
      if (suborder.status === "confirmed") continue;
      const itemResult = await this.pool.query<OrderLineRow>(
        `SELECT product_variant_id,sku,quantity FROM customer_order_items
         WHERE tenant_id=$1 AND order_id=$2 AND suborder_id=$3
           AND merchant_id=$4 AND branch_id=$5
         ORDER BY product_variant_id`,
        [suborder.tenant_id, job.order_id, suborder.id, suborder.merchant_id, suborder.branch_id]
      );
      if (itemResult.rows.length < 1) {
        await this.recordRecovery(job, payment, "TASK_COMMIT_REJECTED", suborder.id,
          reservations.map(item => ({ suborderId: item.suborder.id, reservationReference: item.reservationReference })));
        await this.releaseHeldReservations(reservations);
        for (const candidate of orderedSuborders) {
          await this.moveToHoldIfSafe(job, candidate, "invalid_order_lines");
        }
        return { needsReview: true, failureCode: "ORDER_LINES_MISSING" };
      }
      const reservationRequest = {
        tenantId: suborder.tenant_id,
        orderId: job.order_id,
        suborderId: suborder.id,
        merchantId: suborder.merchant_id,
        branchId: suborder.branch_id,
        idempotencyKey: `paid-checkout:${job.tenant_id}:${job.order_id}:${suborder.id}`,
        requestedAtUtc: this.now().toISOString(),
        lines: itemResult.rows.map(line => ({
          productVariantId: line.product_variant_id, sku: line.sku, quantity: Number(line.quantity)
        }))
      };
      const reservation = await reserveInventoryForPaidOrder({
        paymentCaptured: true, port: this.inventory, request: reservationRequest
      });
      if (reservation.state === "unavailable" || reservation.state === "unguaranteed") {
        const code: CheckoutRecoveryFailureCode = reservation.state === "unavailable"
          ? "INVENTORY_UNAVAILABLE" : "INVENTORY_UNGUARANTEED";
        const references = reservations.map(item => ({
          suborderId: item.suborder.id, reservationReference: item.reservationReference
        }));
        await this.recordRecovery(job, payment, code, suborder.id, references);
        // Compensate successful earlier branch holds when a later branch cannot reserve.
        // Provider release is idempotent; if an adapter has not implemented it yet,
        // keep the hold and leave its reference in the durable recovery case for review.
        await this.releaseHeldReservations(reservations);
        for (const candidate of orderedSuborders) {
          await this.moveToHoldIfSafe(job, candidate, reservation.state);
        }
        return { needsReview: true, failureCode: code };
      }
      reservations.push({
        suborder,
        request: reservation.providerIntegrationId
          ? { ...reservationRequest, providerIntegrationId: reservation.providerIntegrationId }
          : reservationRequest,
        reservationReference: reservation.reservationReference
      });
    }

    // All exact branch reservations now exist. Advance each suborder independently;
    // any transition failure is captured with every reservation reference for review.
    for (const item of reservations) {
      let current = item.suborder;
      if (current.status === "pending_validation") {
        const awaiting = await this.transition(current, job.order_id, "awaiting_payment");
        if (awaiting.outcome !== "updated") {
          await this.recordRecovery(job, payment, "TASK_COMMIT_REJECTED", current.id,
            reservations.map(entry => ({ suborderId: entry.suborder.id, reservationReference: entry.reservationReference })));
          return { needsReview: true, failureCode: "SUBORDER_PAYMENT_STAGE_REJECTED" };
        }
        current = { ...current, status: "awaiting_payment", version: current.version + 1 };
      }
      const confirmed = await this.transition(current, job.order_id, "confirmed");
      if (confirmed.outcome !== "updated") {
        await this.recordRecovery(job, payment, "TASK_COMMIT_REJECTED", current.id,
          reservations.map(entry => ({ suborderId: entry.suborder.id, reservationReference: entry.reservationReference })));
        return { needsReview: true, failureCode: "SUBORDER_CONFIRMATION_REJECTED" };
      }
    }
    return { needsReview: false };
  }

  private async transition(
    suborder: SuborderRow, orderId: string, nextStatus: "awaiting_payment" | "confirmed"
  ) {
    const occurredAt = this.now().toISOString();
    const actorId = this.options.workerId;
    const auditEvent = createAuditEvent({
      id: this.createId(), type: "order.suborder.transitioned", category: "order_lifecycle",
      occurredAt, actor: { id: actorId, type: "system", role: "paid_checkout_reservation_worker" },
      action: "order.suborder.transition", outcome: "success",
      resourceType: "merchant_suborder", resourceId: suborder.id,
      tenantId: suborder.tenant_id, merchantId: suborder.merchant_id, branchId: suborder.branch_id,
      correlationId: `paid-checkout:${orderId}`, source: "worker", severity: "info",
      metadata: { orderId, previousStatus: suborder.status, nextStatus }
    });
    return this.transitions.transitionSuborder({
      tenantId: suborder.tenant_id, orderId, suborderId: suborder.id, nextStatus,
      context: { actorId, actorRole: "system", occurredAt, expectedVersion: suborder.version },
      auditEvent
    });
  }

  private async releaseHeldReservations(
    reservations: readonly {
      request: import("./inventory-reservation.js").InventoryReservationRequest;
      reservationReference: string;
    }[]
  ): Promise<void> {
    if (!this.inventory.releaseExactReservation) return;
    for (const held of reservations) {
      try {
        await this.inventory.releaseExactReservation(
          held.request, held.reservationReference, this.now().toISOString()
        );
      } catch {
        // The recovery case was persisted before compensation began and contains
        // every exact hold reference. Do not retry the whole paid-checkout saga:
        // a provider may have released an earlier hold before this failure, and
        // replaying reserve with the same key could return a terminal hold.
        // Leave the order on hold for the recovery workflow/operator instead.
      }
    }
  }

  private async moveToHoldIfSafe(
    job: ReservationJobRow, suborder: SuborderRow,
    state: "unavailable" | "unguaranteed" | "invalid_order_lines"
  ): Promise<void> {
    if (suborder.status === "on_hold" || suborder.status === "confirmed") return;
    if (suborder.status !== "pending_validation" && suborder.status !== "awaiting_payment") return;
    const occurredAt = this.now().toISOString();
    const auditEvent = createAuditEvent({
      id: this.createId(), type: "order.suborder.transitioned", category: "order_lifecycle",
      occurredAt, actor: { id: this.options.workerId, type: "system", role: "paid_checkout_reservation_worker" },
      action: "order.suborder.transition", outcome: "success",
      resourceType: "merchant_suborder", resourceId: suborder.id,
      tenantId: suborder.tenant_id, merchantId: suborder.merchant_id, branchId: suborder.branch_id,
      correlationId: `paid-checkout:${job.order_id}`, source: "worker", severity: "warning",
      metadata: { orderId: job.order_id, previousStatus: suborder.status, nextStatus: "on_hold" }
    });
    await this.transitions.transitionSuborder({
      tenantId: suborder.tenant_id, orderId: job.order_id, suborderId: suborder.id,
      nextStatus: "on_hold",
      context: {
        actorId: this.options.workerId, actorRole: "system", occurredAt,
        expectedVersion: suborder.version,
        reason: state === "unavailable" ? "Paid order inventory is unavailable" :
          state === "invalid_order_lines" ? "Paid order lines failed inventory validation" :
            "Merchant inventory hard reservation is not guaranteed"
      },
      auditEvent
    });
  }

  private async recordRecovery(
    job: ReservationJobRow, payment: PaidOrderRow, failureCode: CheckoutRecoveryFailureCode,
    suborderId: string | undefined,
    reservationReferences: readonly { suborderId: string; reservationReference: string }[]
  ): Promise<void> {
    const result = await this.recovery.record({
      tenantId: payment.tenant_id, orderId: job.order_id,
      idempotencyKey: `paid-checkout-recovery:${job.id}:${failureCode}`,
      failureCode, ...(suborderId === undefined ? {} : { failedSuborderId: suborderId }),
      paymentReference: payment.provider_payment_reference,
      paymentCapturedAtUtc: payment.captured_at instanceof Date
        ? payment.captured_at.toISOString() : new Date(payment.captured_at).toISOString(),
      reservationReferences
    });
    if (result.outcome === "identity_collision") throw new Error("CHECKOUT_RECOVERY_IDENTITY_COLLISION");
  }
}
