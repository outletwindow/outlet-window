import { randomUUID } from "node:crypto";
import type { PermissionGrant } from "../../../packages/domain/src/authorization.js";
import type { RoleAssignment } from "../../../packages/domain/src/identity.js";
import {
  PostgresIamStore,
  type PostgresPool
} from "../../../packages/domain/src/postgres-iam-store.js";
import { buildApp, type AppOptions, type MerchantBranchReader, type CustomerDeliveryDestinationService, type CustomerPaymentAdjustmentActions, type MerchantCatalogRepository, type SallaOAuthFlow, type PaymentCaptureWebhookHandler, type PaymentRefundWebhookHandler } from "./app.js";
import { PostgresMerchantBranchReader } from "../../../packages/domain/src/postgres-merchant-branch-reader.js";
import { PostgresMerchantOrderReader } from "../../../packages/domain/src/postgres-merchant-order-reader.js";
import { PostgresMerchantBranchWriter } from "../../../packages/domain/src/postgres-merchant-branch-writer.js";
import { PostgresInventoryProviderBranchScopeStore } from "../../../packages/domain/src/postgres-inventory-provider-branch-scope-store.js";
import { PostgresAuditEventStore } from "../../../packages/domain/src/postgres-audit-event-store.js";
import { PostgresOrderTransitionStore } from "../../../packages/domain/src/postgres-order-transition-store.js";
import { PostgresPaymentAdjustmentStore } from "../../../packages/domain/src/postgres-payment-adjustment-store.js";
import { PostgresMerchantSettlementReader } from "../../../packages/domain/src/postgres-merchant-settlement-reader.js";
import { PostgresMerchantSettlementApprovalStore } from "../../../packages/domain/src/postgres-merchant-settlement-approval-store.js";
import { PostgresMerchantSettlementAccountingPoster } from "../../../packages/domain/src/postgres-merchant-settlement-accounting-poster.js";
import { PostgresMerchantPayoutAuthorizationStore } from "../../../packages/domain/src/postgres-merchant-payout-authorization-store.js";
import { PostgresMerchantPayoutProviderOutbox } from "../../../packages/domain/src/postgres-merchant-payout-provider-outbox.js";
import { PostgresMerchantPayoutProviderEntityRegistry } from "../../../packages/domain/src/postgres-merchant-payout-provider-entity-registry.js";
import { MoyasarMerchantPayoutConfirmationWebhookProcessor } from "../../../packages/domain/src/moyasar-merchant-payout-webhook.js";
import { PostgresMoyasarMerchantPayoutConfirmationStore } from "../../../packages/domain/src/postgres-moyasar-merchant-payout-confirmation-store.js";
import { IntegrationHub } from "../../../packages/domain/src/integration-hub.js";
import { PostgresIntegrationRegistryStore } from "../../../packages/domain/src/postgres-integration-registry-store.js";
import { PostgresPaymentWebhookInbox } from "../../../packages/domain/src/postgres-payment-webhook-inbox.js";
import { PostgresMerchantCatalog } from "../../../packages/domain/src/postgres-merchant-catalog.js";
import { MerchantCatalogImportService } from "../../../packages/domain/src/merchant-catalog-import-service.js";
import type { CommerceConnectorRegistry } from "../../../packages/domain/src/commerce-connectors.js";
import { PostgresCommerceCatalogStore } from "../../../packages/domain/src/postgres-commerce-catalog-store.js";
import { BranchInventorySyncService, PostgresBranchInventorySyncStore } from "../../../packages/domain/src/branch-inventory-sync.js";
import { PostgresBranchInventoryReader } from "../../../packages/domain/src/postgres-branch-inventory-reader.js";
import { PostgresBranchInventoryReservationLifecycle } from "../../../packages/domain/src/postgres-branch-inventory-reservation-lifecycle.js";
import { PostgresFulfillmentHandoverInbox } from "../../../packages/domain/src/postgres-fulfillment-handover-inbox.js";
import { PostgresFulfillmentProviderScopeAuthorizer } from "../../../packages/domain/src/postgres-fulfillment-provider-scope-authorizer.js";
import { PostgresMerchantOrderItemPreparationStore } from "../../../packages/domain/src/postgres-merchant-order-item-preparation.js";
import { PostgresCourierTaskStore } from "../../../packages/domain/src/postgres-courier-task-store.js";
import { PostgresCourierPickupCodeIssuer } from "../../../packages/domain/src/postgres-courier-pickup-code-issuer.js";
import { PostgresCourierDispatchOfferStore } from "../../../packages/domain/src/postgres-courier-dispatch-offer-store.js";
import { PostgresCourierDispatchOfferCommandStore, type CourierDispatchOfferEligibility } from "../../../packages/domain/src/postgres-courier-dispatch-offer-command-store.js";
import { PostgresCourierDispatchOfferEligibility } from "../../../packages/domain/src/postgres-courier-dispatch-offer-eligibility.js";
import { PostgresCourierAvailabilityStore } from "../../../packages/domain/src/postgres-courier-availability-store.js";
import { PostgresCourierAdminStore } from "../../../packages/domain/src/postgres-courier-admin-store.js";
import { PostgresCourierDeliveryEvidenceService, type CourierProofObjectStorage } from "../../../packages/domain/src/postgres-courier-delivery-evidence.js";
import { createHmac } from "node:crypto";
import { PostgresPaymentIntentStore } from "../../../packages/domain/src/postgres-payment-intent-store.js";
import { PostgresCustomerPaymentIntentCheckout } from "../../../packages/domain/src/postgres-customer-payment-intent-checkout.js";
import { PostgresCustomerCartStore } from "../../../packages/domain/src/postgres-customer-cart-store.js";
import { PostgresCustomerCheckoutService } from "../../../packages/domain/src/postgres-customer-checkout.js";
import type { MoyasarPaymentIntentClient } from "../../../packages/domain/src/moyasar-payment-intent-client.js";
import { PostgresVerifiedOrderPaymentCaptureStore } from "../../../packages/domain/src/postgres-verified-order-payment-capture.js";
import { PostgresInitialPaymentCaptureInbox } from "../../../packages/domain/src/postgres-initial-payment-capture-inbox.js";
import { VerifiedOrderPaymentCaptureWebhookProcessor, type PaymentCaptureEventDecoder, type PaymentCaptureWebhookVerifier } from "../../../packages/domain/src/verified-order-payment-capture-webhook.js";
import { MoyasarPaymentRefundWebhookProcessor } from "../../../packages/domain/src/moyasar-payment-refund-webhook.js";

export interface PostgresApiOptions {
  pool: PostgresPool;
  digestToken: (secret: string) => Promise<string>;
  grantsForAssignments: (assignments: readonly RoleAssignment[]) => readonly PermissionGrant[];
  now?: () => Date;
  merchantBranches?: MerchantBranchReader;
  serviceName?: string;
  version?: string;
  customerDeliveryDestinations?: CustomerDeliveryDestinationService;
  customerPaymentAdjustments?: CustomerPaymentAdjustmentActions;
  moyasarPaymentIntentClient?: Pick<MoyasarPaymentIntentClient,"createIntent">&Partial<Pick<MoyasarPaymentIntentClient,"fetchIntent">>;
  paymentCallbackUrl?: string;
  merchantCatalog?: MerchantCatalogRepository;
  merchantCatalogImport?: MerchantCatalogImportService;
  commerceConnectors?: CommerceConnectorRegistry;
  paymentWebhookSecretResolver?: (providerKey: string) => Promise<string | null>;
  paymentCaptureWebhookHandler?: PaymentCaptureWebhookHandler;
  paymentRefundWebhookHandler?: PaymentRefundWebhookHandler;
  paymentCaptureDecoders?: ReadonlyMap<string, PaymentCaptureEventDecoder>;
  paymentCaptureWebhookVerifiers?: ReadonlyMap<string, PaymentCaptureWebhookVerifier>;
  fulfillmentWebhookSecretResolver?: (providerKey: string) => Promise<string | null>;
  fulfillmentWebhookAuthorizationResolver?: NonNullable<AppOptions["fulfillmentWebhookAuthorizationResolver"]>;
  sallaOAuthFlow?: SallaOAuthFlow;
  courierDeliveryEvidence?: AppOptions["courierDeliveryEvidence"];
  courierProofObjectStorage?: CourierProofObjectStorage;
  courierDispatchOfferEligibility?: CourierDispatchOfferEligibility;
}

/**
 * Production composition root for PostgreSQL-backed identity/session resolution.
 * The host must supply a configured pool and cryptographic digest implementation.
 */
export function buildPostgresApp(options: PostgresApiOptions) {
  const iam = new PostgresIamStore(options.pool);
  const integrationHub = new IntegrationHub(new PostgresIntegrationRegistryStore(options.pool));
  const paymentWebhookInbox = new PostgresPaymentWebhookInbox(options.pool);
  const moyasarWebhookVerifier = options.paymentCaptureWebhookVerifiers?.get("moyasar");
  const paymentRefundWebhookHandler = options.paymentRefundWebhookHandler ??
    (options.paymentWebhookSecretResolver && moyasarWebhookVerifier
      ? new MoyasarPaymentRefundWebhookProcessor({
          secretResolver: options.paymentWebhookSecretResolver,
          verifier: moyasarWebhookVerifier,
          inbox: paymentWebhookInbox
        })
      : undefined);
  const paymentCaptureWebhookHandler = options.paymentCaptureWebhookHandler ??
    (options.paymentWebhookSecretResolver && options.paymentCaptureDecoders
      ? new VerifiedOrderPaymentCaptureWebhookProcessor({
          secretResolver: options.paymentWebhookSecretResolver,
          decoders: options.paymentCaptureDecoders,
          ...(options.paymentCaptureWebhookVerifiers === undefined ? {} : { webhookVerifiers: options.paymentCaptureWebhookVerifiers }),
          orderResolver: new PostgresPaymentIntentStore(options.pool),
          captureStore: new PostgresVerifiedOrderPaymentCaptureStore(options.pool),
          inboxStore: new PostgresInitialPaymentCaptureInbox(options.pool),
          ...(options.now === undefined ? {} : { now: options.now })
        })
      : undefined);
  const catalogImport = options.merchantCatalogImport ?? (options.commerceConnectors
    ? new MerchantCatalogImportService(
        integrationHub,
        options.commerceConnectors,
        new PostgresCommerceCatalogStore(options.pool)
      )
    : undefined);
  const appOptions: AppOptions = {
    ...(options.serviceName === undefined ? {} : { serviceName: options.serviceName }),
    ...(options.version === undefined ? {} : { version: options.version }),
    merchantBranches: options.merchantBranches ?? new PostgresMerchantBranchReader(options.pool),
    merchantOrderReader: new PostgresMerchantOrderReader(options.pool),
    merchantSettlementReader: new PostgresMerchantSettlementReader(options.pool),
    merchantSettlementApprovals: new PostgresMerchantSettlementApprovalStore(options.pool),
    merchantSettlementAccountingPoster: new PostgresMerchantSettlementAccountingPoster(options.pool),
    merchantPayoutAuthorization: new PostgresMerchantPayoutAuthorizationStore(options.pool),
    merchantPayoutProviderOutbox: new PostgresMerchantPayoutProviderOutbox(options.pool),
    merchantPayoutProviderEntities: new PostgresMerchantPayoutProviderEntityRegistry(options.pool),
    ...(typeof process.env.MOYASAR_PAYOUT_WEBHOOK_SECRET === "string" &&
      process.env.MOYASAR_PAYOUT_WEBHOOK_SECRET.length >= 32 ? {
        merchantPayoutConfirmationWebhook: new MoyasarMerchantPayoutConfirmationWebhookProcessor({
          secretResolver: async providerKey =>
            providerKey === "moyasar" ? process.env.MOYASAR_PAYOUT_WEBHOOK_SECRET ?? null : null,
          store: new PostgresMoyasarMerchantPayoutConfirmationStore(options.pool),
          auditActorId: process.env.MOYASAR_PAYOUT_AUDIT_ACTOR_ID ?? "payout-webhook-service",
          expectedLiveMode: process.env.MOYASAR_EXPECT_LIVE === "true"
        })
      } : {}),
    resolveMerchantTenantId: async (merchantId: string) => {
      const result = await options.pool.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM merchants WHERE id = $1 AND status = 'active'",
        [merchantId]
      );
      return result.rows[0]?.tenant_id ?? null;
    },
    merchantBranchWriter: new PostgresMerchantBranchWriter(options.pool),
    auditEvents: new PostgresAuditEventStore(options.pool),
    integrationHub,
    inventoryProviderBranchScopes: new PostgresInventoryProviderBranchScopeStore(options.pool),
    branchInventorySync: new BranchInventorySyncService(new PostgresBranchInventorySyncStore(options.pool), options.now),
    branchInventoryReader: new PostgresBranchInventoryReader(options.pool),
    inventoryReservationLifecycle: new PostgresBranchInventoryReservationLifecycle(options.pool),
    merchantOrderItemPreparation: new PostgresMerchantOrderItemPreparationStore(options.pool),
    ...(options.sallaOAuthFlow === undefined ? {} : { sallaOAuthFlow: options.sallaOAuthFlow }),
    paymentWebhookInbox,
    ...(paymentCaptureWebhookHandler === undefined ? {} : {
      paymentCaptureWebhookHandler
    }),
    ...(paymentRefundWebhookHandler === undefined ? {} : {
      paymentRefundWebhookHandler
    }),
    fulfillmentHandoverInbox: new PostgresFulfillmentHandoverInbox(options.pool),
    fulfillmentWebhookAuthorizationResolver: options.fulfillmentWebhookAuthorizationResolver ??
      ((providerKey, event) => new PostgresFulfillmentProviderScopeAuthorizer(options.pool).isAuthorized(providerKey, event)),
    ...(options.fulfillmentWebhookSecretResolver === undefined ? {} : {
      fulfillmentWebhookSecretResolver: options.fulfillmentWebhookSecretResolver
    }),
    ...(options.fulfillmentWebhookAuthorizationResolver === undefined ? {} : {
      fulfillmentWebhookAuthorizationResolver: options.fulfillmentWebhookAuthorizationResolver
    }),
    merchantCatalog: options.merchantCatalog ?? new PostgresMerchantCatalog(options.pool),
    customerCart: new PostgresCustomerCartStore(options.pool),
    customerCheckout: new PostgresCustomerCheckoutService(options.pool, randomUUID, options.now),
    ...(catalogImport === undefined ? {} : { merchantCatalogImport: catalogImport }),
    ...(options.paymentWebhookSecretResolver === undefined ? {} : {
      paymentWebhookSecretResolver: options.paymentWebhookSecretResolver
    }),
    orderTransitions: new PostgresOrderTransitionStore(options.pool),
    ...((options.courierDeliveryEvidence ?? (options.courierProofObjectStorage
      ? new PostgresCourierDeliveryEvidenceService(options.pool, options.courierProofObjectStorage, options.now)
      : undefined)) === undefined ? {} : {
        courierDeliveryEvidence: options.courierDeliveryEvidence ?? new PostgresCourierDeliveryEvidenceService(options.pool, options.courierProofObjectStorage!, options.now)
      }),
    ...(typeof process.env.COURIER_PICKUP_CODE_PEPPER === "string" && process.env.COURIER_PICKUP_CODE_PEPPER.length >= 32
      ? {
          courierTasks: new PostgresCourierTaskStore(options.pool,
            async code => createHmac("sha256", process.env.COURIER_PICKUP_CODE_PEPPER!).update(code, "utf8").digest("hex"),
            options.now),
          courierPickupCodeIssuer: new PostgresCourierPickupCodeIssuer(options.pool,
            async code => createHmac("sha256", process.env.COURIER_PICKUP_CODE_PEPPER!).update(code, "utf8").digest("hex"),
            options.now)
        }
      : {}),
    courierAvailability: new PostgresCourierAvailabilityStore(options.pool, options.now),
    courierAdminProfiles: new PostgresCourierAdminStore(options.pool, options.now),
    courierDispatchOffers: new PostgresCourierDispatchOfferStore(options.pool),
    courierDispatchOfferCommands: new PostgresCourierDispatchOfferCommandStore(
      options.pool, options.courierDispatchOfferEligibility ?? new PostgresCourierDispatchOfferEligibility(), options.now
    ),
    customerPaymentAdjustments: options.customerPaymentAdjustments ?? (() => {
      const store = new PostgresPaymentAdjustmentStore(options.pool, options.now);
      const providerKey = process.env.PAYMENT_ADJUSTMENT_PROVIDER_KEY;
      const canQueueProviderSubmission = typeof providerKey === "string" &&
        /^[a-zA-Z0-9._-]{1,100}$/.test(providerKey);
      return {
        getCustomerAdjustment: (input: { orderId: string; adjustmentId: string; customerId: string }) =>
          store.getCustomerAdjustment(input),
        consent: (input: { orderId: string; adjustmentId: string; customerId: string }) => store.consent(input),
        ...(canQueueProviderSubmission ? {
          consentAndQueue: (input: { orderId: string; adjustmentId: string; customerId: string }) =>
            store.consentAndQueue({ ...input, providerKey: providerKey! })
        } : {}),
        decline: (input: { orderId: string; adjustmentId: string; customerId: string }) => store.decline(input)
      };
    })(),
    ...(options.customerDeliveryDestinations === undefined ? {} : { customerDeliveryDestinations: options.customerDeliveryDestinations }),
    ...(options.moyasarPaymentIntentClient === undefined || options.paymentCallbackUrl === undefined ? {} : { customerPaymentIntentCheckout: new PostgresCustomerPaymentIntentCheckout(options.pool,options.moyasarPaymentIntentClient,options.paymentCallbackUrl,options.now) }),
    readinessCheck: async () => {
      const requiredMigrations = [
        "0001_identity_access_sessions",
        "0002_merchants_branches",
        "0003_audit_events",
        "0004_customer_orders",
        "0005_marketplace_order_tenancy",
        "0006_scheduled_task_outbox",
        "0007_branch_inventory_reservations",
        "0008_scheduled_task_inbox_leases",
        "0009_fulfillment_provider_receipts",
        "0010_customer_order_editing_and_delivery_destination",
        "0011_service_areas_and_pricing_rules",
        "0012_branch_geolocation",
        "0013_payment_adjustment_consents",
        "0014_payment_provider_webhook_inbox",
        "0015_multi_provider_integration_hub",
        "0016_payment_webhook_worker_envelope",
        "0017_self_healing_incidents",
        "0018_commerce_catalog",
        "0019_salla_oauth_vault",
        "0020_inventory_reservation_line_scope",
        "0021_unique_inventory_handover_evidence",
        "0022_fulfillment_handover_event_inbox",
        "0023_fulfillment_provider_branch_scopes",
        "0024_merchant_order_item_preparation_checks",
        "0025_immutable_preparation_check_evidence",
        "0026_block_preparation_evidence_truncate",
        "0027_verified_order_payment_captures",
        "0028_provider_payment_intents",
        "0029_initial_payment_capture_webhook_inbox",
        "0030_checkout_recovery_cases",
        "0031_positive_verified_payment_capture",
        "0032_payment_intent_creation_attempts",
        "0033_payment_intent_creation_attempt_expiry",
        "0034_catalog_product_publication",
        "0035_customer_durable_carts",
        "0036_inventory_catalog_variant_identity",
        "0037_order_item_catalog_variant_scope",
        "0038_immutable_checkout_pricing_snapshot",
        "0039_single_initial_capture_per_order",
        "0040_paid_checkout_inventory_reservation_jobs",
        "0041_branch_inventory_snapshot_watermark",
        "0042_branch_inventory_reconciliation_alerts",
        "0043_merchant_inventory_provider_branch_scopes",
        "0044_external_inventory_reservation_evidence",
        "0045_checkout_recovery_suborder_scope",
        "0046_checkout_recovery_reservation_scope",
        "0047_checkout_recovery_reservation_error_codes",
        "0048_suborder_delivery_quote_snapshots",
        "0049_double_entry_financial_journal",
        "0050_merchant_settlement_batches",
        "0051_inventory_provider_reservation_release_intents",
        "0052_payment_adjustment_provider_binding",
        "0053_merchant_settlement_journal_uniqueness",
        "0054_payment_adjustment_provider_reference_uniqueness",
        "0055_payment_adjustment_submission_outbox",
        "0056_payment_adjustment_submission_outbox_guards",
        "0057_payment_adjustment_outcome_reconciliation",
        "0058_payment_adjustment_original_capture_binding",
        "0059_payment_refund_balance_reservations",
        "0060_payment_refund_webhook_reconciliation_state",
        "0061_payment_adjustment_reference_optional",
        "0062_moyasar_single_refund_per_payment",
        "0063_courier_delivery_tasks",
        "0064_courier_delivery_proof_uploads",
        "0065_courier_dispatch_offers",
        "0066_courier_one_active_assignment_per_suborder",
        "0067_courier_profiles_and_dispatch_eligibility",
        "0068_courier_pickup_code_issuance_audit",
        "0069_courier_pickup_code_issue_limits",
        "0070_immutable_refund_component_allocations",
        "0071_merchant_settlement_dual_control",
        "0072_merchant_settlement_policy_account_mappings",
        "0073_atomic_merchant_settlement_accounting_posting",
        "0074_merchant_payout_intents_and_dual_control",
        "0075_merchant_payout_provider_outbox",
        "0076_confirmed_merchant_payout_reconciliation",
        "0077_merchant_payout_provider_entity_mapping"
      ];
      const result = await options.pool.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = ANY($1::text[])",
        [requiredMigrations]
      );
      return requiredMigrations.every(version =>
        result.rows.some(row => row.version === version)
      );
    },
    actorResolution: {
      sessions: iam,
      identities: iam,
      digestToken: options.digestToken,
      now: options.now ?? (() => new Date()),
      grantsForAssignments: options.grantsForAssignments
    }
  };
  return buildApp(appOptions);
}
