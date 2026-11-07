import type { PermissionGrant } from "../../../packages/domain/src/authorization.js";
import type { RoleAssignment } from "../../../packages/domain/src/identity.js";
import {
  PostgresIamStore,
  type PostgresPool
} from "../../../packages/domain/src/postgres-iam-store.js";
import { buildApp, type AppOptions, type MerchantBranchReader } from "./app.js";
import { PostgresMerchantBranchReader } from "../../../packages/domain/src/postgres-merchant-branch-reader.js";

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
    readinessCheck: async () => {
      await options.pool.query("SELECT 1");
      return true;
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
