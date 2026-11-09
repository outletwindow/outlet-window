import { createHash } from "node:crypto";
import { Pool } from "pg";
import { buildPostgresApp } from "./postgres-app.js";
import { buildApp } from "./app.js";
import { grantsForAssignments } from "./permissions.js";
import { SallaOAuthHttpClient } from "../../../packages/domain/src/salla-oauth-http-client.js";
import { SallaOAuthFlowService, PostgresSallaOAuthStateStore, PostgresSallaOAuthTokenVault, PostgresSallaRefreshLock } from "../../../packages/domain/src/postgres-salla-oauth.js";
import { PostgresIntegrationRegistryStore } from "../../../packages/domain/src/postgres-integration-registry-store.js";

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


const sallaOAuthEnvironment = [
  process.env.SALLA_CLIENT_ID,
  process.env.SALLA_CLIENT_SECRET,
  process.env.SALLA_REDIRECT_URI,
  process.env.SALLA_TOKEN_ENCRYPTION_KEY
];
const sallaOAuthConfigured = sallaOAuthEnvironment.every(value => typeof value === "string" && value.length > 0);
if (sallaOAuthEnvironment.some(Boolean) && !sallaOAuthConfigured) {
  throw new Error("Salla OAuth requires SALLA_CLIENT_ID, SALLA_CLIENT_SECRET, SALLA_REDIRECT_URI and SALLA_TOKEN_ENCRYPTION_KEY together");
}
if (sallaOAuthConfigured && !pool) {
  throw new Error("Salla OAuth requires DATABASE_URL and PostgreSQL-backed state/token storage");
}
const sallaOAuthFlow = sallaOAuthConfigured && pool
  ? new PostgresSallaOAuthFlowService(
      new PostgresSallaOAuthStateStore(pool),
      new PostgresSallaOAuthTokenVault(pool, process.env.SALLA_TOKEN_ENCRYPTION_KEY!),
      new SallaOAuthHttpClient({
        clientId: process.env.SALLA_CLIENT_ID!,
        clientSecret: process.env.SALLA_CLIENT_SECRET!,
        redirectUri: process.env.SALLA_REDIRECT_URI!
      }),
      new PostgresSallaRefreshLock(pool),
      async (tenantId, integrationId) => {
        const outcome = await new PostgresIntegrationRegistryStore(pool).updateStatus(
          tenantId, integrationId, "pending", "connected", new Date().toISOString()
        );
        if (outcome !== "updated") throw new Error("SALLA_INTEGRATION_STATUS_UPDATE_FAILED");
      }
    )
  : undefined;

const app = pool
  ? buildPostgresApp({
      pool,
      digestToken: async secret => createHash("sha256").update(secret, "utf8").digest("hex"),
      grantsForAssignments,
      ...(sallaOAuthFlow === undefined ? {} : { sallaOAuthFlow })
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
