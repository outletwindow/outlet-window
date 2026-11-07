import type { PostgresClient } from "./postgres-iam-store.js";

export interface SqlMigration {
  version: string;
  sql: string;
}
export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies ordered SQL migrations using a PostgreSQL advisory lock.
 * The caller supplies reviewed migration text; this runner never reads files or env vars.
 */
export async function applyPostgresMigrations(
  client: PostgresClient,
  migrations: readonly SqlMigration[],
  lockId = 731_004_202
): Promise<MigrationResult> {
  const versions = migrations.map(item => item.version);
  if (versions.some(version => !/^[0-9]{4}_[a-z0-9_]+$/.test(version)) ||
      new Set(versions).size !== versions.length) {
    throw new Error("Migration versions must be unique and use YYYY_name format");
  }

  const ordered = [...migrations].sort((a, b) => a.version.localeCompare(b.version));
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  let locked = false;

  try {
    await client.query("SELECT pg_advisory_lock($1)", [lockId]);
    locked = true;
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");

    for (const migration of ordered) {
      const found = await client.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = $1", [migration.version]
      );
      if (found.rows.length > 0) {
        alreadyApplied.push(migration.version);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
        await client.query("COMMIT");
        applied.push(migration.version);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return { applied, alreadyApplied };
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
  }
}
