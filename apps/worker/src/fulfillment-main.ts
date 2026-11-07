import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  PostgresScheduledTaskInboxStore,
  createFulfillmentDispatchHandlers,
  runScheduledTaskInboxBatch
} from "../../../packages/domain/src/index.js";
import { createHttpFulfillmentProvider } from "./http-fulfillment-provider.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required; fulfillment worker will not start");

const pollMs = Number.parseInt(process.env.FULFILLMENT_WORKER_POLL_MS ?? "1000", 10);
const batchSize = Number.parseInt(process.env.FULFILLMENT_WORKER_BATCH_SIZE ?? "10", 10);
if (!Number.isSafeInteger(pollMs) || pollMs < 250 || pollMs > 60_000) {
  throw new Error("FULFILLMENT_WORKER_POLL_MS must be between 250 and 60000");
}
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
  throw new Error("FULFILLMENT_WORKER_BATCH_SIZE must be between 1 and 100");
}

// All three connectors are required. This prevents unconfigured task types from being
// claimed and incorrectly dead-lettered as NO_CONSUMER_HANDLER.
const handlers = createFulfillmentDispatchHandlers({
  merchant_preparation: createHttpFulfillmentProvider({
    endpoint: process.env.MERCHANT_PREPARATION_ENDPOINT,
    bearerToken: process.env.MERCHANT_PREPARATION_TOKEN,
    providerName: "MERCHANT_PREPARATION"
  }),
  shopper_collection: createHttpFulfillmentProvider({
    endpoint: process.env.SHOPPER_COLLECTION_ENDPOINT,
    bearerToken: process.env.SHOPPER_COLLECTION_TOKEN,
    providerName: "SHOPPER_COLLECTION"
  }),
  courier_dispatch: createHttpFulfillmentProvider({
    endpoint: process.env.COURIER_DISPATCH_ENDPOINT,
    bearerToken: process.env.COURIER_DISPATCH_TOKEN,
    providerName: "COURIER_DISPATCH"
  })
});

const pool = new Pool({
  connectionString: databaseUrl,
  max: 5,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  ...(process.env.NODE_ENV === "production" ? { ssl: { rejectUnauthorized: true } } : {})
});
const store = new PostgresScheduledTaskInboxStore(pool);
let running = false;
let stopping = false;
let interval: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  if (running || stopping) return;
  running = true;
  try {
    const result = await runScheduledTaskInboxBatch({
      store, handlers,
      nowUtc: new Date().toISOString(),
      leaseToken: randomUUID(),
      leaseDurationSeconds: 90,
      limit: batchSize,
      maxAttempts: 8,
      baseDelaySeconds: 15,
      maxDelaySeconds: 900,
      clock: () => new Date()
    });
    if (result.claimed > 0) process.stdout.write(JSON.stringify({
      event: "fulfillment_inbox_batch", ...result,
      occurredAtUtc: new Date().toISOString()
    }) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      event: "fulfillment_worker_error",
      errorCode: error instanceof Error && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.message)
        ? error.message : "FULFILLMENT_BATCH_FAILED",
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
  process.stdout.write(JSON.stringify({ event: "fulfillment_worker_stopping", signal }) + "\n");
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
    ["0008_scheduled_task_inbox_leases"]
  );
  if (migration.rowCount !== 1) throw new Error("scheduled_task_inbox_migration_required");
  process.stdout.write(JSON.stringify({
    event: "fulfillment_worker_started", pollMs, batchSize,
    configuredHandlers: Object.keys(handlers)
  }) + "\n");
  await tick();
  interval = setInterval(() => void tick(), pollMs);
} catch (error) {
  await pool.end();
  throw error;
}
