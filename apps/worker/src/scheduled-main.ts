import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  PostgresScheduledTaskInboxPublisher,
  PostgresScheduledTaskOutboxStore,
  runScheduledTaskBatch
} from "../../../packages/domain/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required; scheduled worker will not start without durable storage");

const pollMs = Number.parseInt(process.env.SCHEDULED_WORKER_POLL_MS ?? "1000", 10);
const batchSize = Number.parseInt(process.env.SCHEDULED_WORKER_BATCH_SIZE ?? "10", 10);
if (!Number.isSafeInteger(pollMs) || pollMs < 250 || pollMs > 60_000) {
  throw new Error("SCHEDULED_WORKER_POLL_MS must be between 250 and 60000");
}
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
  throw new Error("SCHEDULED_WORKER_BATCH_SIZE must be between 1 and 100");
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 5,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  ...(process.env.NODE_ENV === "production" ? { ssl: { rejectUnauthorized: true } } : {})
});
const store = new PostgresScheduledTaskOutboxStore(pool);
const publisher = new PostgresScheduledTaskInboxPublisher(pool);
let running = false;
let stopping = false;
let interval: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  if (running || stopping) return;
  running = true;
  try {
    const result = await runScheduledTaskBatch({
      store,
      publisher,
      nowUtc: new Date().toISOString(),
      leaseToken: randomUUID(),
      leaseDurationSeconds: 60,
      limit: batchSize,
      maxAttempts: 8,
      baseDelaySeconds: 15,
      maxDelaySeconds: 900,
      clock: () => new Date()
    });
    if (result.claimed > 0) process.stdout.write(JSON.stringify({
      event: "scheduled_task_batch",
      ...result,
      occurredAtUtc: new Date().toISOString()
    }) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      event: "scheduled_task_worker_error",
      errorCode: error instanceof Error && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.message)
        ? error.message : "WORKER_BATCH_FAILED",
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
  process.stdout.write(JSON.stringify({ event: "scheduled_worker_stopping", signal }) + "\n");
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
    ["0006_scheduled_task_outbox"]
  );
  if (migration.rowCount !== 1) throw new Error("scheduled_task_outbox_migration_required");
  process.stdout.write(JSON.stringify({ event: "scheduled_worker_started", pollMs, batchSize }) + "\n");
  await tick();
  interval = setInterval(() => void tick(), pollMs);
} catch (error) {
  await pool.end();
  throw error;
}
