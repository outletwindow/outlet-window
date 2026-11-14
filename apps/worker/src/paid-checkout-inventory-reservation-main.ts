import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  UnconfiguredMerchantInventoryReservationAdapter,
  PostgresCheckoutRecoveryCaseStore,
  PostgresOrderTransitionStore,
  PostgresPaidCheckoutInventoryReservationWorker
} from "../../../packages/domain/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required; paid checkout reservation worker will not start");
const pollMs = Number.parseInt(process.env.PAID_CHECKOUT_RESERVATION_WORKER_POLL_MS ?? "1000", 10);
const leaseSeconds = Number.parseInt(process.env.PAID_CHECKOUT_RESERVATION_WORKER_LEASE_SECONDS ?? "60", 10);
if (!Number.isSafeInteger(pollMs) || pollMs < 250 || pollMs > 60_000) {
  throw new Error("PAID_CHECKOUT_RESERVATION_WORKER_POLL_MS must be between 250 and 60000");
}
if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) {
  throw new Error("PAID_CHECKOUT_RESERVATION_WORKER_LEASE_SECONDS must be between 5 and 300");
}
const pool = new Pool({
  connectionString: databaseUrl, max: 6, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
  ...(process.env.NODE_ENV === "production" ? { ssl: { rejectUnauthorized: true } } : {})
});
const workerId = randomUUID();
const worker = new PostgresPaidCheckoutInventoryReservationWorker(
  pool,
  new UnconfiguredMerchantInventoryReservationAdapter(),
  new PostgresOrderTransitionStore(pool),
  new PostgresCheckoutRecoveryCaseStore(pool),
  { workerId, leaseSeconds }
);
let running = false;
let stopping = false;
let interval: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  if (running || stopping) return;
  running = true;
  try {
    const result = await worker.runOnce();
    if (result.outcome !== "idle") {
      process.stdout.write(JSON.stringify({
        event: "paid_checkout_inventory_reservation_job",
        ...result, workerId, occurredAtUtc: new Date().toISOString()
      }) + "\n");
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({
      event: "paid_checkout_inventory_reservation_worker_error",
      errorCode: error instanceof Error && /^[A-Za-z0-9_.:-]{1,100}$/.test(error.message)
        ? error.message : "PAID_CHECKOUT_RESERVATION_WORKER_FAILED",
      occurredAtUtc: new Date().toISOString()
    }) + "\n");
  } finally { running = false; }
}
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (interval) clearInterval(interval);
  process.stdout.write(JSON.stringify({ event: "paid_checkout_reservation_worker_stopping", signal }) + "\n");
  while (running) await new Promise(resolve => setTimeout(resolve, 50));
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await pool.query("SELECT 1");
  const required = [
    "0007_branch_inventory_reservations", "0027_verified_order_payment_captures",
    "0030_checkout_recovery_cases", "0039_single_initial_capture_per_order",
    "0040_paid_checkout_inventory_reservation_jobs", "0041_branch_inventory_snapshot_watermark", "0042_branch_inventory_reconciliation_alerts", "0043_merchant_inventory_provider_branch_scopes"
  ];
  const migrations = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations WHERE version=ANY($1::text[])", [required]
  );
  if (migrations.rows.length !== required.length) {
    throw new Error("paid_checkout_reservation_worker_migration_required");
  }
  process.stdout.write(JSON.stringify({
    event: "paid_checkout_reservation_worker_started", workerId, pollMs, leaseSeconds
  }) + "\n");
  await tick();
  interval = setInterval(() => void tick(), pollMs);
} catch (error) {
  await pool.end();
  throw error;
}
