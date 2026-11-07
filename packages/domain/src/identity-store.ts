import type {
  AccountStatus,
  IdentityProfile,
  RoleAssignment,
  SessionDescriptor
} from "./identity.js";

export interface IdentityStoreTransaction {
  insertIdentity(identity: IdentityProfile): Promise<"inserted" | "already_exists">;
  updateIdentityStatus(input: {
    principalId: string;
    expectedStatus: AccountStatus;
    nextStatus: AccountStatus;
    updatedAt: string;
  }): Promise<boolean>;
  insertRoleAssignment(assignment: RoleAssignment): Promise<"inserted" | "already_exists">;
  revokeSession(input: {
    sessionId: string;
    principalId: string;
    revokedAt: string;
  }): Promise<boolean>;
}

export interface IdentityTransactionRunner {
  /** All writes in the callback must commit atomically or roll back together. */
  run<T>(work: (transaction: IdentityStoreTransaction) => Promise<T>): Promise<T>;
}

export interface IdentityReader {
  findIdentityById(input: { principalId: string }): Promise<IdentityProfile | null>;
  listActiveRoleAssignments(input: { principalId: string; atUtc: string }): Promise<readonly RoleAssignment[]>;
  findSession(input: { sessionId: string; principalId: string }): Promise<SessionDescriptor | null>;
}

export function isIdentityProfileValid(identity: IdentityProfile): boolean {
  if (!identity.id.trim()) return false;
  if (!["human", "service"].includes(identity.principalType)) return false;
  if (!["pending_verification", "active", "temporarily_restricted", "suspended",
    "recovery_pending", "closed", "deletion_requested"].includes(identity.status)) return false;
  const created = Date.parse(identity.createdAt);
  const updated = Date.parse(identity.updatedAt);
  if (!Number.isFinite(created) || !Number.isFinite(updated) || updated < created) return false;
  if (identity.displayName !== undefined && !identity.displayName.trim()) return false;
  if (identity.primaryEmail !== undefined &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.primaryEmail)) return false;
  if (identity.primaryPhone !== undefined && !/^\+[1-9]\d{6,14}$/.test(identity.primaryPhone)) return false;
  return identity.primaryEmail !== undefined || identity.primaryPhone !== undefined ||
    identity.principalType === "service";
}

export function isRoleAssignmentValid(assignment: RoleAssignment): boolean {
  if (!assignment.id.trim() || !assignment.principalId.trim() || !assignment.assignedBy.trim()) return false;
  const from = Date.parse(assignment.validFrom);
  const until = assignment.validUntil === undefined ? undefined : Date.parse(assignment.validUntil);
  if (!Number.isFinite(from) || (until !== undefined && (!Number.isFinite(until) || until <= from))) return false;
  const scope = assignment.scope;
  if (scope.platform === true) {
    return scope.countryCode === undefined && scope.cityId === undefined &&
      scope.merchantId === undefined && scope.branchId === undefined &&
      scope.orderId === undefined && scope.taskId === undefined;
  }
  if (scope.branchId && !scope.merchantId) return false;
  if (scope.cityId && !scope.countryCode) return false;
  return Boolean(scope.countryCode || scope.cityId || scope.merchantId ||
    scope.orderId || scope.taskId);
}

export function isRoleAssignmentActiveAt(assignment: RoleAssignment, atUtc: string): boolean {
  const at = Date.parse(atUtc);
  const from = Date.parse(assignment.validFrom);
  const until = assignment.validUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(assignment.validUntil);
  return assignment.active && Number.isFinite(at) && Number.isFinite(from) &&
    Number.isFinite(until) && from <= at && at < until;
}
