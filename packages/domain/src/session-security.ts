import { isSessionDescriptorValid, type PrincipalType, type SessionDescriptor } from "./identity.js";

export interface StoredSession {
  descriptor: SessionDescriptor;
  /** Store only a cryptographic digest of the opaque bearer token, never the raw token. */
  tokenDigest: string;
  familyId: string;
  rotatedFromSessionId?: string;
  tokenIssuedAt: string;
  idleExpiresAt: string;
}

export type SessionValidationResult =
  | { valid: true }
  | { valid: false; reason: "missing" | "revoked" | "expired" | "idle_expired" | "invalid_descriptor" | "principal_mismatch" };

export interface SessionStoreTransaction {
  insertSession(session: StoredSession): Promise<"inserted" | "already_exists">;
  /** Compare-and-swap rotation: succeeds only if the old session is active and digest matches. */
  rotateSession(input: {
    oldSessionId: string;
    principalId: string;
    expectedTokenDigest: string;
    replacement: StoredSession;
    rotatedAt: string;
  }): Promise<"rotated" | "not_active" | "digest_mismatch">;
  /** Revokes every session in a family, including descendants created by rotation. */
  revokeSessionFamily(input: {
    familyId: string;
    principalId: string;
    revokedAt: string;
    reason: "logout" | "token_reuse" | "security_event" | "password_reset";
  }): Promise<number>;
}

export interface SessionStoreReader {
  findStoredSession(input: { sessionId: string; principalId: string }): Promise<StoredSession | null>;
  /** Lookup by opaque session id only; token digest comparison remains mandatory in the resolver. */
  findStoredSessionById(input: { sessionId: string }): Promise<StoredSession | null>;
}

export interface SessionTransactionRunner {
  run<T>(work: (transaction: SessionStoreTransaction) => Promise<T>): Promise<T>;
}

export function validateStoredSession(input: {
  session: StoredSession | null;
  principalId: string;
  principalType: PrincipalType;
  nowUtc: string;
}): SessionValidationResult {
  const session = input.session;
  if (!session) return { valid: false, reason: "missing" };
  if (session.descriptor.principalId !== input.principalId) {
    return { valid: false, reason: "principal_mismatch" };
  }
  if (!session.tokenDigest.trim() || !session.familyId.trim() ||
      !session.descriptor.id.trim() ||
      !Number.isFinite(Date.parse(input.nowUtc)) ||
      !Number.isFinite(Date.parse(session.tokenIssuedAt)) ||
      !Number.isFinite(Date.parse(session.idleExpiresAt)) ||
      !Number.isFinite(Date.parse(session.descriptor.expiresAt)) ||
      !Number.isFinite(Date.parse(session.descriptor.createdAt)) ||
      !Number.isFinite(Date.parse(session.descriptor.lastSeenAt))) {
    return { valid: false, reason: "invalid_descriptor" };
  }
  if (session.descriptor.revokedAt) return { valid: false, reason: "revoked" };
  if (Date.parse(session.descriptor.expiresAt) <= Date.parse(input.nowUtc)) {
    return { valid: false, reason: "expired" };
  }
  if (Date.parse(session.idleExpiresAt) <= Date.parse(input.nowUtc)) {
    return { valid: false, reason: "idle_expired" };
  }
  if (!isSessionDescriptorValid(input.principalType, session.descriptor)) {
    return { valid: false, reason: "invalid_descriptor" };
  }
  return { valid: true };
}

// Token generation and cryptographic hashing are supplied by approved infrastructure adapters.
