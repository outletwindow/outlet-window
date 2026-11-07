import { describe, expect, it } from "vitest";
import { applyPostgresMigrations } from "./postgres-migrations.js";
import type { PostgresClient } from "./postgres-iam-store.js";

function fakeClient(failOnSql?: string) {
  const calls: string[] = [];
  const applied = new Set<string>();
  const client: PostgresClient = {
    release() {},
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      calls.push(sql);
      if (sql === "SELECT version FROM schema_migrations WHERE version = $1") {
        const version = String(values[0]);
        return { rows: (applied.has(version) ? [{ version }] : []) as Row[], rowCount: applied.has(version) ? 1 : 0 };
      }
      if (sql.startsWith("INSERT INTO schema_migrations")) {
        applied.add(String(values[0]));
      }
      if (failOnSql && sql === failOnSql) throw new Error("migration failed");
      return { rows: [] as Row[], rowCount: 1 };
    }
  };
  return { client, calls, applied };
}

describe("PostgreSQL migration runner", () => {
  it("applies migrations once in order under an advisory lock", async () => {
    const fake = fakeClient();
    const migrations = [
      { version: "0002_second", sql: "SELECT 2" },
      { version: "0001_first", sql: "SELECT 1" }
    ];
    const first = await applyPostgresMigrations(fake.client, migrations);
    expect(first.applied).toEqual(["0001_first", "0002_second"]);
    expect(fake.calls[0]).toContain("pg_advisory_lock");
    expect(fake.calls.at(-1)).toContain("pg_advisory_unlock");

    const second = await applyPostgresMigrations(fake.client, migrations);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(["0001_first", "0002_second"]);
  });

  it("rejects duplicate or malformed migration versions", async () => {
    const fake = fakeClient();
    await expect(applyPostgresMigrations(fake.client, [
      { version: "bad-version", sql: "SELECT 1" }
    ])).rejects.toThrow("Migration versions");
  });

  it("releases the advisory lock and rolls back a failed migration", async () => {
    const fake = fakeClient("BROKEN SQL");
    await expect(applyPostgresMigrations(fake.client, [
      { version: "0001_broken", sql: "BROKEN SQL" }
    ])).rejects.toThrow("migration failed");
    expect(fake.calls).toContain("ROLLBACK");
    expect(fake.calls.at(-1)).toContain("pg_advisory_unlock");
  });
});
