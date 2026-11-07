import type { AccountStatus, IdentityProfile, RoleAssignment, SessionDescriptor } from "./identity.js";
import type { IdentityReader, IdentityStoreTransaction, IdentityTransactionRunner } from "./identity-store.js";
import type { SessionStoreReader, SessionStoreTransaction, SessionTransactionRunner, StoredSession } from "./session-security.js";

/** Minimal PostgreSQL-compatible query surface; compatible with pg Pool/PoolClient. */
export interface PostgresQueryResult<Row> { rows: Row[]; rowCount: number | null }
export interface PostgresQueryable {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>>;
}
export interface PostgresPool extends PostgresQueryable {
  connect(): Promise<PostgresClient>;
}
export interface PostgresClient extends PostgresQueryable { release(): void }

type IdentityRow = {
  id: string; principal_type: IdentityProfile["principalType"]; status: AccountStatus;
  display_name: string | null; primary_email: string | null; primary_phone: string | null;
  created_at: Date | string; updated_at: Date | string;
};
type RoleRow = {
  id: string; principal_id: string; role: RoleAssignment["role"]; scope: RoleAssignment["scope"];
  active: boolean; valid_from: Date | string; valid_until: Date | string | null; assigned_by: string;
};
type SessionRow = {
  id: string; principal_id: string; created_at: Date | string; expires_at: Date | string;
  last_seen_at: Date | string; revoked_at: Date | string | null; device_label: string | null;
  authentication_methods: SessionDescriptor["authenticationMethods"]; token_digest: string;
  family_id: string; rotated_from_session_id: string | null; token_issued_at: Date | string;
  idle_expires_at: Date | string;
};
const iso = (value: Date | string) => new Date(value).toISOString();
const maybeIso = (value: Date | string | null) => value === null ? undefined : iso(value);
function identityFromRow(row: IdentityRow): IdentityProfile {
  return {
    id: row.id, principalType: row.principal_type, status: row.status,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.primary_email === null ? {} : { primaryEmail: row.primary_email }),
    ...(row.primary_phone === null ? {} : { primaryPhone: row.primary_phone }),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}
function roleFromRow(row: RoleRow): RoleAssignment {
  return {
    id: row.id, principalId: row.principal_id, role: row.role, scope: row.scope,
    active: row.active, validFrom: iso(row.valid_from),
    ...(row.valid_until === null ? {} : { validUntil: iso(row.valid_until) }),
    assignedBy: row.assigned_by
  };
}
function sessionFromRow(row: SessionRow): StoredSession {
  return {
    descriptor: {
      id: row.id, principalId: row.principal_id, createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at), lastSeenAt: iso(row.last_seen_at),
      ...(row.revoked_at === null ? {} : { revokedAt: iso(row.revoked_at) }),
      ...(row.device_label === null ? {} : { deviceLabel: row.device_label }),
      authenticationMethods: row.authentication_methods
    },
    tokenDigest: row.token_digest, familyId: row.family_id,
    ...(row.rotated_from_session_id === null ? {} : { rotatedFromSessionId: row.rotated_from_session_id }),
    tokenIssuedAt: iso(row.token_issued_at), idleExpiresAt: iso(row.idle_expires_at)
  };
}

/**
 * Durable IAM adapter. Supply a configured PostgreSQL pool from the host application.
 * The adapter never creates a pool or reads connection secrets itself.
 */
export class PostgresIamStore implements IdentityReader, SessionStoreReader,
  IdentityTransactionRunner, SessionTransactionRunner {
  constructor(private readonly pool: PostgresPool) {}

  async findIdentityById(input: { principalId: string }): Promise<IdentityProfile | null> {
    const result = await this.pool.query<IdentityRow>(
      "SELECT * FROM identities WHERE id = $1", [input.principalId]
    );
    return result.rows[0] ? identityFromRow(result.rows[0]) : null;
  }

  async listActiveRoleAssignments(input: { principalId: string; atUtc: string }): Promise<readonly RoleAssignment[]> {
    const result = await this.pool.query<RoleRow>(
      "SELECT * FROM role_assignments WHERE principal_id = $1 AND active = true AND valid_from <= $2 AND (valid_until IS NULL OR valid_until > $2) ORDER BY id",
      [input.principalId, input.atUtc]
    );
    return result.rows.map(roleFromRow);
  }

  async findSession(input: { sessionId: string; principalId: string }): Promise<SessionDescriptor | null> {
    const result = await this.pool.query<SessionRow>(
      "SELECT * FROM sessions WHERE id = $1 AND principal_id = $2", [input.sessionId, input.principalId]
    );
    return result.rows[0] ? sessionFromRow(result.rows[0]).descriptor : null;
  }

  async findStoredSession(input: { sessionId: string; principalId: string }): Promise<StoredSession | null> {
    const result = await this.pool.query<SessionRow>(
      "SELECT * FROM sessions WHERE id = $1 AND principal_id = $2", [input.sessionId, input.principalId]
    );
    return result.rows[0] ? sessionFromRow(result.rows[0]) : null;
  }

  async findStoredSessionById(input: { sessionId: string }): Promise<StoredSession | null> {
    const result = await this.pool.query<SessionRow>(
      "SELECT * FROM sessions WHERE id = $1", [input.sessionId]
    );
    return result.rows[0] ? sessionFromRow(result.rows[0]) : null;
  }

  run<T>(work: (transaction: IdentityStoreTransaction) => Promise<T>): Promise<T>;
  run<T>(work: (transaction: SessionStoreTransaction) => Promise<T>): Promise<T>;
  async run<T>(work: (transaction: any) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const transaction = this.transaction(client);
      const value = await work(transaction);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private transaction(client: PostgresClient): IdentityStoreTransaction & SessionStoreTransaction {
    return {
      insertIdentity: async (identity) => {
        const result = await client.query(
          "INSERT INTO identities (id, principal_type, status, display_name, primary_email, primary_phone, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id",
          [identity.id, identity.principalType, identity.status, identity.displayName ?? null,
            identity.primaryEmail ?? null, identity.primaryPhone ?? null, identity.createdAt, identity.updatedAt]
        );
        return result.rowCount ? "inserted" : "already_exists";
      },
      updateIdentityStatus: async (input) => {
        const result = await client.query(
          "UPDATE identities SET status = $3, updated_at = $4 WHERE id = $1 AND status = $2",
          [input.principalId, input.expectedStatus, input.nextStatus, input.updatedAt]
        );
        return result.rowCount === 1;
      },
      insertRoleAssignment: async (assignment) => {
        const result = await client.query(
          "INSERT INTO role_assignments (id, principal_id, role, scope, active, valid_from, valid_until, assigned_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id",
          [assignment.id, assignment.principalId, assignment.role, JSON.stringify(assignment.scope),
            assignment.active, assignment.validFrom, assignment.validUntil ?? null, assignment.assignedBy]
        );
        return result.rowCount ? "inserted" : "already_exists";
      },
      revokeSession: async (input) => {
        const result = await client.query(
          "UPDATE sessions SET revoked_at = $3 WHERE id = $1 AND principal_id = $2 AND revoked_at IS NULL",
          [input.sessionId, input.principalId, input.revokedAt]
        );
        return result.rowCount === 1;
      },
      insertSession: async (session) => {
        const result = await client.query(
          "INSERT INTO sessions (id, principal_id, created_at, expires_at, last_seen_at, revoked_at, device_label, authentication_methods, token_digest, family_id, rotated_from_session_id, token_issued_at, idle_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id",
          [session.descriptor.id, session.descriptor.principalId, session.descriptor.createdAt,
            session.descriptor.expiresAt, session.descriptor.lastSeenAt, session.descriptor.revokedAt ?? null,
            session.descriptor.deviceLabel ?? null, JSON.stringify(session.descriptor.authenticationMethods),
            session.tokenDigest, session.familyId, session.rotatedFromSessionId ?? null,
            session.tokenIssuedAt, session.idleExpiresAt]
        );
        return result.rowCount ? "inserted" : "already_exists";
      },
      rotateSession: async (input) => {
        const locked = await client.query<{ id: string }>(
          "SELECT id FROM sessions WHERE id = $1 AND principal_id = $2 AND token_digest = $3 AND revoked_at IS NULL AND expires_at > $4 AND idle_expires_at > $4 FOR UPDATE",
          [input.oldSessionId, input.principalId, input.expectedTokenDigest, input.rotatedAt]
        );
        if (!locked.rowCount) {
          const existing = await client.query<{ token_digest: string }>(
            "SELECT token_digest FROM sessions WHERE id = $1 AND principal_id = $2",
            [input.oldSessionId, input.principalId]
          );
          return existing.rows[0] && existing.rows[0].token_digest !== input.expectedTokenDigest
            ? "digest_mismatch" : "not_active";
        }
        const revoked = await client.query(
          "UPDATE sessions SET revoked_at = $3 WHERE id = $1 AND principal_id = $2 AND revoked_at IS NULL",
          [input.oldSessionId, input.principalId, input.rotatedAt]
        );
        if (revoked.rowCount !== 1) return "not_active";
        const inserted = await this.transaction(client).insertSession(input.replacement);
        if (inserted !== "inserted") throw new Error("Replacement session already exists; rotation rolled back");
        return "rotated";
      },
      revokeSessionFamily: async (input) => {
        const result = await client.query(
          "UPDATE sessions SET revoked_at = $3 WHERE family_id = $1 AND principal_id = $2 AND revoked_at IS NULL",
          [input.familyId, input.principalId, input.revokedAt]
        );
        return result.rowCount ?? 0;
      }
    };
  }
}
