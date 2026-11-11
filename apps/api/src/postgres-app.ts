import type { PermissionGrant } from "../../../packages/domain/src/authorization.js";
import type { RoleAssignment } from "../../../packages/domain/src/identity.js";
import {
  PostgresIamStore,
  type PostgresPool
} from "../../../packages/domain/src/postgres-iam-store.js";
import { buildApp, type AppOptions, type MerchantBranchReader, type CustomerDeliveryDestinationService, type CustomerPaymentAdjustmentActions, type MerchantCatalogRepository, type SallaOAuthFlow, type PaymentCaptureWebhookHandler } from "./app.js";
import { PostgresMerchantBranchReader } from "../../../packages/domain/src/postgres-merchant-branch-reader.js";
import { PostgresMerchantBranchWriter } from "../../../packages/domain/src/postgres-merchant-branch-writer.js";
import { PostgresAuditEventStore } from "../../../packages/domain/src/postgres-audit-event-store.js";
import { PostgresOrderTransitionStore } from "../../../packages/domain/src/postgres-order-transition-store.js";
import { PostgresPaymentAdjustmentStore } from "../../../packages/domain/src/postgres-payment-adjustment-store.js";
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
import { PostgresPaymentIntentStore } from "../../../packages/domain/src/postgres-payment-intent-store.js";
import { PostgresCustomerPaymentIntentCheckout } from "../../../packages/domain/src/postgres-customer-payment-intent-checkout.js";
import type { MoyasarPaymentIntentClient } from "../../../packages/domain/src/moyasar-payment-intent-client.js";
import { PostgresVerifiedOrderPaymentCaptureStore } from "../../../packages/domain/src/postgres-verified-order-payment-capture.js";
import { PostgresInitialPaymentCaptureInbox } from "../../../packages/domain/src/postgres-initial-payment-capture-inbox.js";
import { VerifiedOrderPaymentCaptureWebhookProcessor, type PaymentCaptureEventDecoder, type PaymentCaptureWebhookVerifier } from "../../../packages/domain/src/verified-order-payment-capture-webhook.js";

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
  paymentCaptureDecoders?: ReadonlyMap<string, PaymentCaptureEventDecoder>;
  paymentCaptureWebhookVerifiers?: ReadonlyMap<string, PaymentCaptureWebhookVerifier>;
  fulfillmentWebhookSecretResolver?: (providerKey: string) => Promise<string | null>;
  fulfillmentWebhookAuthorizationResolver?: NonNullable<AppOptions["fulfillmentWebhookAuthorizationResolver"]>;
  sallaOAuthFlow?: SallaOAuthFlow;
}

/**
 * Production composition root for PostgreSQL-backed identity/session resolution.
 * The host must supply a configured pool and cryptographic digest implementation.
 */
export function buildPostgresApp(options: PostgresApiOptions) {
  const iam = new PostgresIamStore(options.pool);
  const integrationHub = new IntegrationHub(new PostgresIntegrationRegistryStore(options.pool));
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
    branchInventorySync: new BranchInventorySyncService(new PostgresBranchInventorySyncStore(options.pool), options.now),
    branchInventoryReader: new PostgresBranchInventoryReader(options.pool),
    inventoryReservationLifecycle: new PostgresBranchInventoryReservationLifecycle(options.pool),
    merchantOrderItemPreparation: new PostgresMerchantOrderItemPreparationStore(options.pool),
    ...(options.sallaOAuthFlow === undefined ? {} : { sallaOAuthFlow: options.sallaOAuthFlow }),
    paymentWebhookInbox: new PostgresPaymentWebhookInbox(options.pool),
    ...(paymentCaptureWebhookHandler === undefined ? {} : {
      paymentCaptureWebhookHandler
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
    ...(catalogImport === undefined ? {} : { merchantCatalogImport: catalogImport }),
    ...(options.paymentWebhookSecretResolver === undefined ? {} : {
      paymentWebhookSecretResolver: options.paymentWebhookSecretResolver
    }),
    orderTransitions: new PostgresOrderTransitionStore(options.pool),
    customerPaymentAdjustments: options.customerPaymentAdjustments ?? (() => {
      const store = new PostgresPaymentAdjustmentStore(options.pool, options.now);
      return {
        consent: (input: { orderId: string; adjustmentId: string; customerId: string }) => store.consent(input),
        decline: (input: { orderId: string; adjustmentId: string; customerId: string }) => store.decline(input)
      };
    })(),
    ...(options.customerDeliveryDestinations === undefined ? {} : { customerDeliveryDestinations: options.customerDeliveryDestinations }),
    ...(options.moyasarPaymentIntentClient === undefined || options.paymentCallbackUrl === undefined ? {} : { customerPaymentIntentCheckout: new PostgresCustomerPaymentIntentCheckout(options.pool,options.moyasarPaymentIntentClient,options.paymentCallbackUrl) }),
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
        "0034_catalog_product_publication"
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
