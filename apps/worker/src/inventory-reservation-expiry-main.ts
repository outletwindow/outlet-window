import { Pool } from "pg";
import {
  PostgresBranchInventoryReservationLifecycle,
  PostgresInventoryReservationExpiryWorker
} from "../../../packages/domain/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required; inventory expiry worker will not start");

const pollMs = Number.parseInt(process.env.INVENTORY_EXPIRY_WORKER_POLL_MS ?? "5000", 10);
const batchSize = Number.parseInt(process.env.INVENTORY_EXPIRY_WORKER_BATCH_SIZE ?? "50", 10);
if (!Number.isSafeInteger(pollMs) || pollMs < 500 || pollMs > 60_000) {
  throw new Error("INVENTORY_EXPIRY_WORKER_POLL_MS must be between 500 and 60000");
}
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
  throw new Error("INVENTORY_EXPIRY_WORKER_BATCH_SIZE must be between 1 and 500");
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 4,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  ...(process.env.NODE_ENV === "production" ? { ssl: { rejectUnauthorized: true } } : {})
});
const lifecycle = new PostgresBranchInventoryReservationLifecycle(pool);
const worker = new PostgresInventoryReservationExpiryWorker(pool, lifecycle);
let running = false;
let stopping = false;
let interval: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  if (running || stopping) return;
  running = true;
  try {
    const result = await worker.runOnce({ nowUtc: new Date().toISOString(), limit: batchSize });
    if (result.selected > 0) {
      process.stdout.write(JSON.stringify({
        event: "inventory_reservation_expiry_batch",
        ...result,
        occurredAtUtc: new Date().toISOString()
      }) + "\n");
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({
      event: "inventory_reservation_expiry_error",
      errorCode: error instanceof Error && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.message)
        ? error.message : "INVENTORY_EXPIRY_BATCH_FAILED",
      occurredAtUtc: new Date().toISOString()
    }) + "\n");
  } finally {
    running = false;
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (interval) clearInterval(interval);
  process.stdout.write(JSON.stringify({ event: "inventory_expiry_worker_stopping", signal }) + "\n");
  while (running) await new Promise(resolve => setTimeout(resolve, 50));
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await pool.query("SELECT 1");
  const migration = await pool.query(
    "SELECT version FROM schema_migrations WHERE version = $1",
    ["0007_branch_inventory_reservations"]
  );
  if (migration.rowCount !== 1) throw new Error("branch_inventory_reservations_migration_required");
  process.stdout.write(JSON.stringify({
    event: "inventory_expiry_worker_started", pollMs, batchSize
  }) + "\n");
  await tick();
  interval = setInterval(() => void tick(), pollMs);
} catch (error) {
  await pool.end();
  throw error;
}
