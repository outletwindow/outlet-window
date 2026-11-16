import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresVerifiedCaptureFinancialJournalProjector } from "../../../packages/domain/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required; financial journal projection worker will not start");
const pollMs = Number.parseInt(process.env.FINANCIAL_JOURNAL_PROJECTION_POLL_MS ?? "5000", 10);
const batchSize = Number.parseInt(process.env.FINANCIAL_JOURNAL_PROJECTION_BATCH_SIZE ?? "25", 10);
if (!Number.isSafeInteger(pollMs) || pollMs < 500 || pollMs > 60_000) {
  throw new Error("FINANCIAL_JOURNAL_PROJECTION_POLL_MS must be between 500 and 60000");
}
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 250) {
  throw new Error("FINANCIAL_JOURNAL_PROJECTION_BATCH_SIZE must be between 1 and 250");
}
const pool = new Pool({
  connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
  ...(process.env.NODE_ENV === "production" ? { ssl: { rejectUnauthorized: true } } : {})
});
const workerId = randomUUID();
const projector = new PostgresVerifiedCaptureFinancialJournalProjector(pool);
let running = false;
let stopping = false;
let interval: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  if (running || stopping) return;
  running = true;
  try {
    const results = await projector.projectPending(batchSize);
    if (results.length) {
      process.stdout.write(JSON.stringify({
        event: "verified_capture_financial_projection_batch",
        workerId,
        processed: results.length,
        outcomes: results.reduce<Record<string, number>>((counts, result) => {
          counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
          return counts;
        }, {}),
        occurredAtUtc: new Date().toISOString()
      }) + "\n");
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({
      event: "verified_capture_financial_projection_worker_error",
      errorCode: error instanceof Error && /^[A-Za-z0-9_.:-]{1,100}$/.test(error.message)
        ? error.message : "FINANCIAL_JOURNAL_PROJECTION_FAILED",
      occurredAtUtc: new Date().toISOString()
    }) + "\n");
  } finally { running = false; }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (interval) clearInterval(interval);
  process.stdout.write(JSON.stringify({ event: "financial_journal_projection_worker_stopping", signal }) + "\n");
  while (running) await new Promise(resolve => setTimeout(resolve, 50));
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await pool.query("SELECT 1");
  const required = ["0027_verified_order_payment_captures", "0049_double_entry_financial_journal"];
  const migrations = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations WHERE version=ANY($1::text[])", [required]
  );
  if (migrations.rows.length !== required.length) {
    throw new Error("financial_journal_projection_worker_migration_required");
  }
  process.stdout.write(JSON.stringify({
    event: "financial_journal_projection_worker_started", workerId, pollMs, batchSize
  }) + "\n");
  await tick();
  interval = setInterval(() => void tick(), pollMs);
} catch (error) {
  await pool.end();
  throw error;
}
