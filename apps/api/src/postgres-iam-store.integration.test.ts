import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresIamStore } from "../../../packages/domain/src/postgres-iam-store.js";
import type { SessionStoreTransaction } from "../../../packages/domain/src/session-security.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 5 }) : null;

integration("PostgresIamStore against PostgreSQL", () => {
  if (!pool) throw new Error("Pool must exist when DATABASE_URL is configured");
  const store = new PostgresIamStore(pool);
  const principalId = `integration-${randomUUID()}`;
  const otherPrincipalId = `integration-${randomUUID()}`;
  const oldSessionId = `session-${randomUUID()}`;
  const familyId = `family-${randomUUID()}`;
  const now = new Date();
  const createdAt = new Date(now.getTime() - 1_000);
  const expiresAt = new Date(now.getTime() + 60 * 60_000);
  const idleExpiresAt = new Date(now.getTime() + 10 * 60_000);
  const replacement = (id: string, digest: string, rotatedFrom?: string) => ({
    descriptor: {
      id, principalId, createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(), lastSeenAt: now.toISOString(),
      authenticationMethods: ["password"] as const
    },
    tokenDigest: digest,
    familyId,
    ...(rotatedFrom ? { rotatedFromSessionId: rotatedFrom } : {}),
    tokenIssuedAt: now.toISOString(),
    idleExpiresAt: idleExpiresAt.toISOString()
  });

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO identities (id, principal_type, status, primary_email, created_at, updated_at) VALUES ($1,'human','active',$2,$3,$3),($4,'human','active',$5,$3,$3)",
      [principalId, `${principalId}@example.test`, now, otherPrincipalId, `${otherPrincipalId}@example.test`]
    );
    const inserted = await store.run(async tx => (tx as unknown as SessionStoreTransaction).insertSession(replacement(oldSessionId, "digest-original")) );
    expect(inserted).toBe("inserted");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM sessions WHERE principal_id = ANY($1::text[])", [[principalId, otherPrincipalId]]);
    await pool.query("DELETE FROM role_assignments WHERE principal_id = ANY($1::text[])", [[principalId, otherPrincipalId]]);
    await pool.query("DELETE FROM identities WHERE id = ANY($1::text[])", [[principalId, otherPrincipalId]]);
    await pool.end();
  });

  it("enforces principal binding on session reads", async () => {
    expect(await store.findStoredSession({ sessionId: oldSessionId, principalId })).not.toBeNull();
    expect(await store.findStoredSession({ sessionId: oldSessionId, principalId: otherPrincipalId })).toBeNull();
  });

  it("allows exactly one concurrent rotation of the same active session", async () => {
    const nextA = replacement(`session-${randomUUID()}`, "digest-next-a", oldSessionId);
    const nextB = replacement(`session-${randomUUID()}`, "digest-next-b", oldSessionId);
    const rotate = (next: typeof nextA) => store.run(tx => (tx as unknown as SessionStoreTransaction).rotateSession({
      oldSessionId, principalId, expectedTokenDigest: "digest-original",
      replacement: next, rotatedAt: now.toISOString()
    }));
    const results = await Promise.all([rotate(nextA), rotate(nextB)]);
    expect(results.filter(result => result === "rotated")).toHaveLength(1);
    expect(results.filter(result => result === "not_active")).toHaveLength(1);
    const old = await store.findStoredSession({ sessionId: oldSessionId, principalId });
    expect(old?.descriptor.revokedAt).toBe(now.toISOString());
    const family = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM sessions WHERE family_id = $1 AND principal_id = $2 AND revoked_at IS NULL",
      [familyId, principalId]
    );
    expect(Number(family.rows[0]?.count)).toBe(1);
  });
});
