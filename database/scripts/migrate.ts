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
    const migrations = await Promise.all([
      { version: "0001_identity_access_sessions", file: "0001_identity_access_sessions.sql" },
      { version: "0002_merchants_branches", file: "0002_merchants_branches.sql" },
      { version: "0003_audit_events", file: "0003_audit_events.sql" },
      { version: "0004_customer_orders", file: "0004_customer_orders.sql" },
      { version: "0005_marketplace_order_tenancy", file: "0005_marketplace_order_tenancy.sql" },
      { version: "0006_scheduled_task_outbox", file: "0006_scheduled_task_outbox.sql" },
      { version: "0007_branch_inventory_reservations", file: "0007_branch_inventory_reservations.sql" },
      { version: "0008_scheduled_task_inbox_leases", file: "0008_scheduled_task_inbox_leases.sql" },
      { version: "0009_fulfillment_provider_receipts", file: "0009_fulfillment_provider_receipts.sql" },
      { version: "0010_customer_order_editing_and_delivery_destination", file: "0010_customer_order_editing_and_delivery_destination.sql" },
      { version: "0011_service_areas_and_pricing_rules", file: "0011_service_areas_and_pricing_rules.sql" },
      { version: "0012_branch_geolocation", file: "0012_branch_geolocation.sql" },
      { version: "0013_payment_adjustment_consents", file: "0013_payment_adjustment_consents.sql" }
    ].map(async migration => ({
      version: migration.version,
      sql: await readFile(resolve(process.cwd(), `../../database/migrations/${migration.file}`), "utf8")
    })));
    const client = await pool.connect();
    try {
      const result = await applyPostgresMigrations(
        client as unknown as PostgresClient,
        migrations
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
