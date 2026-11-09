import type { PermissionGrant } from "../../../packages/domain/src/authorization.js";
import type { RoleAssignment } from "../../../packages/domain/src/identity.js";
import {
  PostgresIamStore,
  type PostgresPool
} from "../../../packages/domain/src/postgres-iam-store.js";
import { buildApp, type AppOptions, type MerchantBranchReader, type CustomerDeliveryDestinationService, type CustomerPaymentAdjustmentActions, type MerchantCatalogRepository } from "./app.js";
import { PostgresMerchantBranchReader } from "../../../packages/domain/src/postgres-merchant-branch-reader.js";
import { PostgresMerchantBranchWriter } from "../../../packages/domain/src/postgres-merchant-branch-writer.js";
import { PostgresAuditEventStore } from "../../../packages/domain/src/postgres-audit-event-store.js";
import { PostgresOrderTransitionStore } from "../../../packages/domain/src/postgres-order-transition-store.js";
import { PostgresPaymentAdjustmentStore } from "../../../packages/domain/src/postgres-payment-adjustment-store.js";
import { IntegrationHub } from "../../../packages/domain/src/integration-hub.js";
import { PostgresIntegrationRegistryStore } from "../../../packages/domain/src/postgres-integration-registry-store.js";
import { PostgresPaymentWebhookInbox } from "../../../packages/domain/src/postgres-payment-webhook-inbox.js";
import { PostgresMerchantCatalog } from "../../../packages/domain/src/postgres-merchant-catalog.js";
import type { MerchantCatalogImportService } from "../../../packages/domain/src/merchant-catalog-import-service.js";

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
  merchantCatalog?: MerchantCatalogRepository;
  merchantCatalogImport?: MerchantCatalogImportService;
  paymentWebhookSecretResolver?: (providerKey: string) => Promise<string | null>;
}

/**
 * Production composition root for PostgreSQL-backed identity/session resolution.
 * The host must supply a configured pool and cryptographic digest implementation.
 */
export function buildPostgresApp(options: PostgresApiOptions) {
  const iam = new PostgresIamStore(options.pool);
  const appOptions: AppOptions = {
    ...(options.serviceName === undefined ? {} : { serviceName: options.serviceName }),
    ...(options.version === undefined ? {} : { version: options.version }),
    merchantBranches: options.merchantBranches ?? new PostgresMerchantBranchReader(options.pool),
    merchantBranchWriter: new PostgresMerchantBranchWriter(options.pool),
    auditEvents: new PostgresAuditEventStore(options.pool),
    integrationHub: new IntegrationHub(new PostgresIntegrationRegistryStore(options.pool)),
    paymentWebhookInbox: new PostgresPaymentWebhookInbox(options.pool),
    merchantCatalog: options.merchantCatalog ?? new PostgresMerchantCatalog(options.pool),
    ...(options.merchantCatalogImport === undefined ? {} : { merchantCatalogImport: options.merchantCatalogImport }),
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
        "0018_commerce_catalog"
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
