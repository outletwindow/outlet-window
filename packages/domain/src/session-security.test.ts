import { describe, expect, it } from "vitest";
import { validateStoredSession, type StoredSession } from "./session-security.js";

const stored: StoredSession = {
  descriptor: {
    id: "session-1", principalId: "principal-1",
    createdAt: "2026-11-07T09:00:00.000Z",
    expiresAt: "2026-11-07T17:00:00.000Z",
    lastSeenAt: "2026-11-07T10:00:00.000Z",
    authenticationMethods: ["passkey", "mfa"]
  },
  tokenDigest: "sha256:digest-value", familyId: "family-1",
  tokenIssuedAt: "2026-11-07T09:00:00.000Z",
  idleExpiresAt: "2026-11-07T11:00:00.000Z"
};

describe("session security contracts", () => {
  it("accepts a valid active session", () => {
    expect(validateStoredSession({
      session: stored, principalId: "principal-1", principalType: "human",
      nowUtc: "2026-11-07T10:30:00.000Z"
    })).toEqual({ valid: true });
  });

  it("rejects missing, revoked, expired and idle-expired sessions", () => {
    const input = { principalId: "principal-1", principalType: "human" as const, nowUtc: "2026-11-07T10:30:00.000Z" };
    expect(validateStoredSession({ ...input, session: null })).toEqual({ valid: false, reason: "missing" });
    expect(validateStoredSession({
      ...input, session: { ...stored, descriptor: { ...stored.descriptor, revokedAt: "2026-11-07T10:10:00.000Z" } }
    })).toEqual({ valid: false, reason: "revoked" });
    expect(validateStoredSession({
      ...input, nowUtc: "2026-11-07T18:00:00.000Z", session: stored
    })).toEqual({ valid: false, reason: "expired" });
    expect(validateStoredSession({
      ...input, nowUtc: "2026-11-07T12:00:00.000Z", session: stored
    })).toEqual({ valid: false, reason: "idle_expired" });
  });

  it("rejects a session belonging to another principal", () => {
    expect(validateStoredSession({
      session: stored, principalId: "principal-2", principalType: "human",
      nowUtc: "2026-11-07T10:30:00.000Z"
    })).toEqual({ valid: false, reason: "principal_mismatch" });
  });

  it("rejects service sessions that use human-only authentication", () => {
    expect(validateStoredSession({
      session: stored, principalId: "principal-1", principalType: "service",
      nowUtc: "2026-11-07T10:30:00.000Z"
    })).toEqual({ valid: false, reason: "invalid_descriptor" });
  });

  it("rejects records without token digest or family id", () => {
    expect(validateStoredSession({
      session: { ...stored, tokenDigest: "" }, principalId: "principal-1",
      principalType: "human", nowUtc: "2026-11-07T10:30:00.000Z"
    })).toEqual({ valid: false, reason: "invalid_descriptor" });
  });
});
