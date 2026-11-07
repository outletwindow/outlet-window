import { describe, expect, it } from "vitest";
import { resolveActorFromBearerToken } from "./actor-resolution.js";
import type { IdentityReader } from "./identity-store.js";
import type { SessionStoreReader, StoredSession } from "./session-security.js";
import type { RoleAssignment } from "./identity.js";

const token = "session_12345678." + "a".repeat(40);
const session: StoredSession = {
  descriptor: {
    id: "session_12345678", principalId: "principal-1",
    createdAt: "2026-11-07T09:00:00.000Z",
    expiresAt: "2026-11-07T18:00:00.000Z",
    lastSeenAt: "2026-11-07T10:00:00.000Z",
    authenticationMethods: ["passkey", "mfa"]
  },
  tokenDigest: "digest-value", familyId: "family-1",
  tokenIssuedAt: "2026-11-07T09:00:00.000Z",
  idleExpiresAt: "2026-11-07T17:00:00.000Z"
};
const assignment: RoleAssignment = {
  id: "role-1", principalId: "principal-1", role: "merchant_owner",
  scope: { merchantId: "merchant-1", branchId: "branch-1" },
  active: true, validFrom: "2026-11-07T09:00:00.000Z", assignedBy: "admin-1"
};
function dependencies(options: { stored?: StoredSession | null; identityStatus?: "active" | "suspended"; assignments?: RoleAssignment[] } = {}) {
  const sessions: SessionStoreReader = {
    async findStoredSessionById() { return options.stored === undefined ? session : options.stored; }
  };
  const identities: IdentityReader = {
    async findIdentityById() {
      return {
        id: "principal-1", principalType: "human" as const,
        status: options.identityStatus ?? "active",
        primaryEmail: "person@example.com",
        createdAt: "2026-11-07T08:00:00.000Z",
        updatedAt: "2026-11-07T08:00:00.000Z"
      };
    },
    async listActiveRoleAssignments() { return options.assignments ?? [assignment]; },
    async findSession() { return null; }
  };
  return {
    sessions, identities,
    async digestToken() { return "digest-value"; },
    now: () => new Date("2026-11-07T10:30:00.000Z"),
    grantsForAssignments: () => [{
      resource: "merchant.branch" as const,
      actions: ["read" as const],
      scope: { merchantId: "merchant-1", branchId: "branch-1" }
    }]
  };
}

describe("actor resolution from persisted sessions", () => {
  it("resolves an active identity and valid session to a scoped actor", async () => {
    const result = await resolveActorFromBearerToken({
      authorizationHeader: `Bearer ${token}`, dependencies: dependencies()
    });
    expect(result.actor?.id).toBe("principal-1");
    expect(result.actor?.role).toBe("merchant_owner");
  });

  it("rejects absent or malformed bearer tokens", async () => {
    const deps = dependencies();
    expect(await resolveActorFromBearerToken({ authorizationHeader: undefined, dependencies: deps }))
      .toEqual({ actor: null, failure: "missing_token" });
    expect(await resolveActorFromBearerToken({ authorizationHeader: "Bearer bad", dependencies: deps }))
      .toEqual({ actor: null, failure: "malformed_token" });
  });

  it("rejects an invalid token digest or missing session", async () => {
    const deps = dependencies();
    const badDigest = { ...deps, async digestToken() { return "wrong"; } };
    expect((await resolveActorFromBearerToken({
      authorizationHeader: `Bearer ${token}`, dependencies: badDigest
    })).failure).toBe("invalid_session");
    expect((await resolveActorFromBearerToken({
      authorizationHeader: `Bearer ${token}`, dependencies: dependencies({ stored: null })
    })).failure).toBe("invalid_session");
  });

  it("rejects inactive identities and ambiguous role sets", async () => {
    expect((await resolveActorFromBearerToken({
      authorizationHeader: `Bearer ${token}`, dependencies: dependencies({ identityStatus: "suspended" })
    })).failure).toBe("inactive_identity");
    expect((await resolveActorFromBearerToken({
      authorizationHeader: `Bearer ${token}`,
      dependencies: dependencies({ assignments: [assignment, { ...assignment, id: "role-2", role: "branch_manager" }] })
    })).failure).toBe("invalid_role_assignments");
  });
});
