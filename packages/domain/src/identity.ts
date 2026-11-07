import type { PlatformRole, AccessScope } from "./authorization.js";

export const ACCOUNT_STATUSES = [
  "pending_verification",
  "active",
  "temporarily_restricted",
  "suspended",
  "recovery_pending",
  "closed",
  "deletion_requested"
] as const;

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const PRINCIPAL_TYPES = ["human", "service"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export interface IdentityProfile {
  id: string;
  principalType: PrincipalType;
  status: AccountStatus;
  displayName?: string;
  primaryEmail?: string;
  primaryPhone?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoleAssignment {
  id: string;
  principalId: string;
  role: PlatformRole;
  scope: AccessScope;
  active: boolean;
  validFrom: string;
  validUntil?: string;
  assignedBy: string;
}

export interface SessionDescriptor {
  id: string;
  principalId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt?: string;
  deviceLabel?: string;
  authenticationMethods: readonly ("password" | "passkey" | "mfa" | "federated")[];
}

export type IdentityLifecycleAction =
  | "activate"
  | "restrict"
  | "suspend"
  | "begin_recovery"
  | "close"
  | "request_deletion";

const ALLOWED_TRANSITIONS: Record<AccountStatus, readonly AccountStatus[]> = {
  pending_verification: ["active", "suspended", "request_deletion" as never],
  active: ["temporarily_restricted", "suspended", "recovery_pending", "closed", "deletion_requested"],
  temporarily_restricted: ["active", "suspended", "recovery_pending", "closed"],
  suspended: ["active", "closed", "deletion_requested"],
  recovery_pending: ["active", "suspended", "closed"],
  closed: ["deletion_requested"],
  deletion_requested: []
};

/** Checks lifecycle transitions; persistence and authorization are enforced by IAM services. */
export function canTransitionAccount(
  current: AccountStatus,
  next: AccountStatus
): boolean {
  return ALLOWED_TRANSITIONS[current].includes(next);
}

/** Service principals must not be assigned human-only authentication methods. */
export function isSessionDescriptorValid(
  principalType: PrincipalType,
  session: SessionDescriptor
): boolean {
  if (!session.id || !session.principalId) return false;
  if (Date.parse(session.expiresAt) <= Date.parse(session.createdAt)) return false;
  if (principalType === "service" && session.authenticationMethods.some(
    (method) => method === "password" || method === "passkey" || method === "mfa"
  )) return false;
  if (session.revokedAt && Date.parse(session.revokedAt) < Date.parse(session.createdAt)) {
    return false;
  }
  return true;
}
