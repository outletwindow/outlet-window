import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { applyPostgresMigrations } from "../../packages/domain/src/postgres-migrations.js";
import type { PostgresClient } from "../../packages/domain/src/postgres-iam-store.js";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to run database migrations");

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    ...(process.env.NODE_ENV === "production" ? { ssl: { rejectUnauthorized: true } } : {})
  });

  try {
    const sql = await readFile(resolve(process.cwd(), "database/migrations/0001_identity_access_sessions.sql"), "utf8");
    const client = await pool.connect();
    try {
      const result = await applyPostgresMigrations(
        client as unknown as PostgresClient,
        [{ version: "0001_identity_access_sessions", sql }]
      );
      process.stdout.write(JSON.stringify(result) + "\n");
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`Database migration failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
