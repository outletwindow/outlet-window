import { createAuditEvent } from "./audit.js";
import type { PostgresClient, PostgresPool } from "./postgres-iam-store.js";
import { PostgresCustomerCartRepricingService } from "./postgres-customer-cart-repricing.js";
import { PostgresCustomerCartStore } from "./postgres-customer-cart-store.js";
import { PostgresDeliveryQuoteService } from "./postgres-delivery-quote-service.js";
import { PostgresOrderStore } from "./postgres-order-store.js";
import { PostgresPlatformCheckoutReadinessStore } from "./postgres-platform-checkout-readiness-store.js";

export interface CustomerCheckoutDestination {
  countryCode: string;
  cityCode: string;
  serviceCode: string;
  latitude: number;
  longitude: number;
  addressSnapshot?: Readonly<Record<string, unknown>>;
}

export interface CreateCustomerCheckoutInput {
  customerId: string;
  expectedCartVersion: number;
  idempotencyKey: string;
  destination: CustomerCheckoutDestination;
  actorId: string;
  actorRole: "customer" | "platform_user" | "system";
  correlationId: string;
}

export type CustomerCheckoutResult =
  | { outcome: "created"; orderId: string; suborderIds: readonly string[]; totalMinor: number; currency: string }
  | { outcome: "not_found" | "version_conflict" | "empty" | "unavailable" | "invalid_snapshot"
      | "unsupported_multi_branch" | "outside_service_area" | "no_active_pricing_rule"
      | "no_eligible_branch" | "invalid_delivery_request" | "idempotency_conflict"
      | "readiness_conflict" | "cart_conversion_conflict" };

function safeIdentifier(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

/**
 * Creates a single-branch customer checkout atomically. This service deliberately
 * does not create payment intents or reserve stock: payment capture verification
 * and the existing reservation workflow remain separate release gates.
 */
export class PostgresCustomerCheckoutService {
  private readonly repricing: PostgresCustomerCartRepricingService;
  private readonly cartStore: PostgresCustomerCartStore;
  private readonly orderStore: PostgresOrderStore;
  private readonly readinessStore: PostgresPlatformCheckoutReadinessStore;

  constructor(
    private readonly pool: PostgresPool,
    private readonly createId: () => string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.repricing = new PostgresCustomerCartRepricingService(pool);
    this.cartStore = new PostgresCustomerCartStore(pool, createId);
    this.orderStore = new PostgresOrderStore(pool);
    this.readinessStore = new PostgresPlatformCheckoutReadinessStore(pool);
  }

  async create(input: CreateCustomerCheckoutInput): Promise<CustomerCheckoutResult> {
    if (!safeIdentifier(input.customerId) || !safeIdentifier(input.idempotencyKey) ||
        input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200 ||
        !safeIdentifier(input.actorId) || !safeIdentifier(input.correlationId) ||
        !Number.isSafeInteger(input.expectedCartVersion) || input.expectedCartVersion < 1 ||
        !/^[A-Z]{2}$/.test(input.destination.countryCode) ||
        !safeIdentifier(input.destination.cityCode) || !safeIdentifier(input.destination.serviceCode) ||
        !Number.isFinite(input.destination.latitude) || input.destination.latitude < -90 ||
        input.destination.latitude > 90 || !Number.isFinite(input.destination.longitude) ||
        input.destination.longitude < -180 || input.destination.longitude > 180) {
      return { outcome: "invalid_delivery_request" };
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const checkoutRequest = {
        expectedCartVersion: input.expectedCartVersion,
        destination: {
          countryCode: input.destination.countryCode,
          cityCode: input.destination.cityCode,
          serviceCode: input.destination.serviceCode,
          latitude: input.destination.latitude,
          longitude: input.destination.longitude,
          ...(input.destination.addressSnapshot === undefined ? {} : { addressSnapshot: input.destination.addressSnapshot })
        }
      };
      const replay = await this.orderStore.resolveCustomerCheckoutIdempotencyInTransaction({
        tenantId: "platform", customerId: input.customerId,
        idempotencyKey: input.idempotencyKey, request: checkoutRequest
      }, client);
      if (replay.outcome === "match") {
        await client.query("COMMIT");
        return { outcome: "created", orderId: replay.orderId, suborderIds: replay.suborderIds,
          totalMinor: replay.totalMinor, currency: replay.currency };
      }
      if (replay.outcome === "conflict") {
        await client.query("ROLLBACK");
        return { outcome: "idempotency_conflict" };
      }

      const priced = await this.repricing.repriceInTransaction({
        customerId: input.customerId, expectedCartVersion: input.expectedCartVersion
      }, client);
      if (priced.outcome !== "priced") {
        // A concurrent request may have committed while this request waited for the
        // customer-cart advisory lock. Resolve its idempotency key before returning
        // the now-converted cart as missing.
        const replayAfterLock = await this.orderStore.resolveCustomerCheckoutIdempotencyInTransaction({
          tenantId: "platform", customerId: input.customerId,
          idempotencyKey: input.idempotencyKey, request: checkoutRequest
        }, client);
        if (replayAfterLock.outcome === "match") {
          await client.query("COMMIT");
          return { outcome: "created", orderId: replayAfterLock.orderId,
            suborderIds: replayAfterLock.suborderIds, totalMinor: replayAfterLock.totalMinor,
            currency: replayAfterLock.currency };
        }
        if (replayAfterLock.outcome === "conflict") {
          await client.query("ROLLBACK");
          return { outcome: "idempotency_conflict" };
        }
        await client.query("ROLLBACK");
        if (priced.outcome === "unavailable") return { outcome: "unavailable" };
        if (priced.outcome === "invalid_snapshot") return { outcome: "invalid_snapshot" };
        return { outcome: priced.outcome };
      }

      // A zone-center quote is not a multi-stop route quote. Do not silently
      // charge a single delivery fee for a cart spanning multiple branches.
      if (priced.suborders.length !== 1) {
        await client.query("ROLLBACK");
        return { outcome: "unsupported_multi_branch" };
      }
      const suborder = priced.suborders[0];
      if (!suborder) {
        await client.query("ROLLBACK");
        return { outcome: "invalid_snapshot" };
      }

      const occurredAt = this.now().toISOString();
      const quoteService = new PostgresDeliveryQuoteService(client);
      const quoteResult = await quoteService.quoteInTransaction({
        tenantId: "platform",
        countryCode: input.destination.countryCode,
        cityCode: input.destination.cityCode,
        serviceCode: input.destination.serviceCode,
        destination: { latitude: input.destination.latitude, longitude: input.destination.longitude },
        quoteId: this.createId(),
        nowUtc: occurredAt
      }, client);
      if (quoteResult.status !== "quoted") {
        await client.query("ROLLBACK");
        if (quoteResult.status === "outside_service_area") return { outcome: "outside_service_area" };
        if (quoteResult.status === "no_active_pricing_rule") return { outcome: "no_active_pricing_rule" };
        if (quoteResult.status === "no_eligible_branch") return { outcome: "no_eligible_branch" };
        return { outcome: "invalid_delivery_request" };
      }
      if (quoteResult.currency !== priced.currency ||
          !quoteResult.eligibleBranches.some(branch =>
            branch.merchantId === suborder.merchantId && branch.branchId === suborder.branchId)) {
        await client.query("ROLLBACK");
        return { outcome: "invalid_snapshot" };
      }

      const totalMinor = priced.subtotalMinor + quoteResult.quote.totalMinor;
      if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) {
        await client.query("ROLLBACK");
        return { outcome: "invalid_snapshot" };
      }
      const components = [
        { kind: "product_subtotal", amountMinor: priced.subtotalMinor, label: "Products" },
        { kind: "delivery", amountMinor: quoteResult.quote.totalMinor, label: "Delivery" }
      ] as const;
      const checkoutPricing = {
        // Keep the request fingerprint inside the database-enforced immutable snapshot.
        checkoutRequest,
        currency: priced.currency,
        deliveryQuoteId: quoteResult.quote.quoteId,
        deliveryRuleId: quoteResult.quote.ruleId,
        deliveryRuleVersion: quoteResult.quote.ruleVersion,
        discountMinor: 0,
        components
      };
      const orderId = this.createId();
      const suborderId = this.createId();
      const orderInput = {
        id: orderId,
        tenantId: "platform",
        customerId: input.customerId,
        idempotencyKey: input.idempotencyKey,
        currency: priced.currency,
        totalMinor,
        metadata: { source: "customer_checkout", checkoutPricing },
        deliveryDestination: {
          countryCode: input.destination.countryCode,
          cityCode: input.destination.cityCode,
          serviceCode: input.destination.serviceCode,
          latitude: input.destination.latitude,
          longitude: input.destination.longitude,
          ...(input.destination.addressSnapshot === undefined ? {} : { address: input.destination.addressSnapshot })
        },
        deliveryQuote: { ...quoteResult.quote },
        deliveryZoneId: quoteResult.serviceAreaId,
        deliveryBranchId: suborder.branchId,
        suborders: [{
          id: suborderId,
          merchantId: suborder.merchantId,
          branchId: suborder.branchId,
          status: "pending_validation" as const,
          subtotalMinor: suborder.subtotalMinor,
          items: suborder.items.map(item => ({
            id: this.createId(),
            productVariantId: item.productVariantId,
            sku: item.sku,
            quantity: item.quantity,
            unitPriceMinor: item.unitPriceMinor,
            currency: item.currency
          }))
        }]
      };
      const created = await this.orderStore.createInTransaction(orderInput, client);
      if (created.outcome !== "created") {
        await client.query("ROLLBACK");
        return { outcome: "idempotency_conflict" };
      }

      const auditEvents = [createAuditEvent({
        id: this.createId(),
        type: "order.suborder.transitioned",
        category: "order_lifecycle",
        occurredAt,
        actor: { id: input.actorId, type: input.actorRole, role: "platform_checkout" },
        action: "order.suborder.transition",
        outcome: "success",
        resourceType: "merchant_suborder",
        resourceId: suborderId,
        tenantId: suborder.merchantTenantId,
        merchantId: suborder.merchantId,
        branchId: suborder.branchId,
        correlationId: input.correlationId,
        source: "customer_checkout",
        severity: "info",
        metadata: {
          orderId,
          previousStatus: "pending_validation",
          nextStatus: "awaiting_payment"
        }
      })];
      const readiness = await this.readinessStore.transitionToAwaitingPaymentInTransaction({
        orderId,
        customerId: input.customerId,
        expectedVersion: 1,
        actorId: input.actorId,
        actorRole: input.actorRole,
        occurredAt,
        auditEvents
      }, client);
      if (readiness.outcome !== "ready") {
        await client.query("ROLLBACK");
        return { outcome: "readiness_conflict" };
      }

      const converted = await this.cartStore.closeAsConvertedInTransaction({
        customerId: input.customerId,
        cartId: priced.cartId,
        expectedCartVersion: priced.cartVersion
      }, client);
      if (converted !== "converted") {
        await client.query("ROLLBACK");
        return { outcome: "cart_conversion_conflict" };
      }

      await client.query("COMMIT");
      return {
        outcome: "created",
        orderId,
        suborderIds: readiness.suborderIds,
        totalMinor,
        currency: priced.currency
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
