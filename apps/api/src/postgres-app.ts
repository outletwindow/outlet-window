import type { PermissionGrant } from "../../../packages/domain/src/authorization.js";
import type { RoleAssignment } from "../../../packages/domain/src/identity.js";
import {
  PostgresIamStore,
  type PostgresPool
} from "../../../packages/domain/src/postgres-iam-store.js";
import { buildApp, type AppOptions, type MerchantBranchReader } from "./app.js";
import { PostgresMerchantBranchReader } from "../../../packages/domain/src/postgres-merchant-branch-reader.js";
import { PostgresMerchantBranchWriter } from "../../../packages/domain/src/postgres-merchant-branch-writer.js";
import { PostgresAuditEventStore } from "../../../packages/domain/src/postgres-audit-event-store.js";
import { PostgresOrderTransitionStore } from "../../../packages/domain/src/postgres-order-transition-store.js";

export interface PostgresApiOptions {
  pool: PostgresPool;
  digestToken: (secret: string) => Promise<string>;
  grantsForAssignments: (assignments: readonly RoleAssignment[]) => readonly PermissionGrant[];
  now?: () => Date;
  merchantBranches?: MerchantBranchReader;
  serviceName?: string;
  version?: string;
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
    orderTransitions: new PostgresOrderTransitionStore(options.pool),
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
        "0010_customer_order_editing_and_delivery_destination"
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
