import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildPostgresApp } from "./postgres-app.js";
import type { PostgresPool } from "../../../packages/domain/src/postgres-iam-store.js";

describe("PostgreSQL API readiness migration gate", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
  });

  function poolMissingMigration(missing: string): PostgresPool {
    return {
      async query<Row>(sql: string, values?: readonly unknown[]) {
        if (sql.includes("SELECT version FROM schema_migrations")) {
          const required = values?.[0] as string[];
          const rows = required
            .filter(version => version !== missing)
            .map(version => ({ version })) as Row[];
          return { rows, rowCount: rows.length };
        }
        return { rows: [] as Row[], rowCount: 0 };
      },
      async connect() {
        throw new Error("unexpected_database_client_request");
      }
    } as unknown as PostgresPool;
  }

  it.each([
    "0024_merchant_order_item_preparation_checks",
    "0025_immutable_preparation_check_evidence",
    "0026_block_preparation_evidence_truncate"
  ])("keeps the API unready when migration %s is missing", async missing => {
    const app = buildPostgresApp({
      pool: poolMissingMigration(missing),
      digestToken: async value => value,
      grantsForAssignments: () => []
    });
    apps.push(app);
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      checks: { process: "ok", database: "unavailable" }
    });
  });
});
