import { createHash } from "node:crypto";
import { Pool } from "pg";
import type { RoleAssignment } from "../../../packages/domain/src/identity.js";
import type { PermissionGrant } from "../../../packages/domain/src/authorization.js";
import { buildPostgresApp } from "./postgres-app.js";
import { buildApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL;
const production = process.env.NODE_ENV === "production";

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
if (production && !databaseUrl) {
  throw new Error("DATABASE_URL is required in production; refusing to start without persistent IAM storage");
}

const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  ...(production ? { ssl: { rejectUnauthorized: true } } : {})
}) : null;

function grantsForAssignments(assignments: readonly RoleAssignment[]): readonly PermissionGrant[] {
  const readRoles = new Set([
    "merchant_owner", "merchant_admin", "branch_manager", "merchant_employee"
  ]);
  const manageRoles = new Set(["merchant_owner", "merchant_admin"]);
  const orderManageRoles = new Set(["merchant_owner", "merchant_admin", "branch_manager"]);
  return assignments.flatMap((assignment): PermissionGrant[] => {
    if (manageRoles.has(assignment.role)) return [
      { resource: "merchant.branch", actions: ["read", "create", "update"] as const, scope: assignment.scope }
    ];
    if (readRoles.has(assignment.role)) return [
      { resource: "merchant.branch", actions: ["read"] as const, scope: assignment.scope }
    ];
    return [];
  });
}

const app = pool
  ? buildPostgresApp({
      pool,
      digestToken: async secret => createHash("sha256").update(secret, "utf8").digest("hex"),
      grantsForAssignments
    })
  : buildApp();

try {
  if (pool) await pool.query("SELECT 1");
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  await pool?.end();
  process.exit(1);
}

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down API");
  try {
    await app.close();
    await pool?.end();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
