import type { Actor, PermissionGrant } from "./authorization.js";
import type { IdentityReader } from "./identity-store.js";
import { isRoleAssignmentActiveAt, isRoleAssignmentValid } from "./identity-store.js";
import type { IdentityProfile, RoleAssignment } from "./identity.js";
import type { SessionStoreReader, StoredSession } from "./session-security.js";
import { validateStoredSession } from "./session-security.js";

export interface ActorResolutionDependencies {
  sessions: SessionStoreReader;
  identities: IdentityReader;
  /** Hashes the presented opaque token secret using the server's approved crypto adapter. */
  digestToken: (tokenSecret: string) => Promise<string>;
  now: () => Date;
  grantsForAssignments: (assignments: readonly RoleAssignment[]) => readonly PermissionGrant[];
}

export type ActorResolutionFailure =
  | "missing_token"
  | "malformed_token"
  | "invalid_session"
  | "inactive_identity"
  | "invalid_role_assignments";

export type ActorResolution =
  | { actor: Actor; failure?: never }
  | { actor: null; failure: ActorResolutionFailure };

/**
 * Token wire format: <sessionId>.<opaqueSecret>.
 * The opaque secret is never used as a database key or logged; only its digest is compared.
 */
export async function resolveActorFromBearerToken(input: {
  authorizationHeader: string | undefined;
  dependencies: ActorResolutionDependencies;
}): Promise<ActorResolution> {
  const header = input.authorizationHeader;
  if (!header) return { actor: null, failure: "missing_token" };
  const match = /^Bearer ([A-Za-z0-9_-]{8,128})\.([A-Za-z0-9_-]{32,256})$/.exec(header);
  if (!match) return { actor: null, failure: "malformed_token" };

  const sessionId = match[1]!;
  const secret = match[2]!;
  const expectedDigest = await input.dependencies.digestToken(secret);
  if (!expectedDigest.trim()) return { actor: null, failure: "invalid_session" };

  // Session id is globally unique and opaque; reader must still enforce principal/session binding.
  const session = await input.dependencies.sessions.findStoredSessionById({ sessionId });
  if (!session || session.tokenDigest !== expectedDigest) {
    return { actor: null, failure: "invalid_session" };
  }

  const nowUtc = input.dependencies.now().toISOString();
  const identity = await input.dependencies.identities.findIdentityById({
    principalId: session.descriptor.principalId
  });
  if (!identity || identity.status !== "active") {
    return { actor: null, failure: "inactive_identity" };
  }

  const validation = validateStoredSession({
    session, principalId: identity.id, principalType: identity.principalType, nowUtc
  });
  if (!validation.valid) return { actor: null, failure: "invalid_session" };

  const assignments = await input.dependencies.identities.listActiveRoleAssignments({
    principalId: identity.id,
    atUtc: nowUtc
  });
  if (assignments.some(assignment =>
    assignment.principalId !== identity.id || !isRoleAssignmentValid(assignment) || !isRoleAssignmentActiveAt(assignment, nowUtc)
  )) return { actor: null, failure: "invalid_role_assignments" };

  const grants = input.dependencies.grantsForAssignments(assignments);
  const roles = [...new Set(assignments.map(assignment => assignment.role))];
  if (roles.length !== 1) {
    // Actor model currently represents one role; do not silently collapse conflicting roles.
    return { actor: null, failure: "invalid_role_assignments" };
  }
  return {
    actor: {
      id: identity.id,
      role: roles[0]!,
      active: true,
      grants
    }
  };
}
