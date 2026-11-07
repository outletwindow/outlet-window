export const PLATFORM_ROLES = [
  "platform_owner",
  "platform_admin",
  "operations",
  "finance",
  "security_auditor",
  "support_agent",
  "merchant_owner",
  "merchant_admin",
  "branch_manager",
  "merchant_employee",
  "customer",
  "shopper",
  "courier",
  "ai_agent",
  "integration_service"
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const ACTIONS = [
  "read",
  "create",
  "update",
  "approve",
  "execute",
  "export",
  "delete",
  "manage_access"
] as const;

export type PermissionAction = (typeof ACTIONS)[number];

export interface AccessScope {
  platform?: boolean;
  countryCode?: string;
  cityId?: string;
  merchantId?: string;
  branchId?: string;
  orderId?: string;
  taskId?: string;
}

export interface PermissionGrant {
  resource: string;
  actions: readonly PermissionAction[];
  scope: AccessScope;
}

export interface Actor {
  id: string;
  /** Primary role retained for compatibility; roles lists every active role assignment. */
  role: PlatformRole;
  roles?: readonly PlatformRole[];
  active: boolean;
  grants: readonly PermissionGrant[];
}

export interface AuthorizationRequest {
  resource: string;
  action: PermissionAction;
  scope: AccessScope;
}

export type AuthorizationDecision =
  | { allowed: true; reason: "matching_grant" }
  | {
      allowed: false;
      reason:
        | "inactive_actor"
        | "missing_identity"
        | "missing_grant"
        | "scope_mismatch";
    };

function scopeMatches(granted: AccessScope, requested: AccessScope): boolean {
  const dimensions: (keyof AccessScope)[] = [
    "countryCode",
    "cityId",
    "merchantId",
    "branchId",
    "orderId",
    "taskId"
  ];

  if (granted.platform === true) return true;

  const grantedDimensions = dimensions.filter((key) => granted[key] !== undefined);
  if (grantedDimensions.length === 0) return false;

  return grantedDimensions.every((key) => {
    const expected = granted[key];
    const actual = requested[key];
    return expected !== undefined && actual === expected;
  });
}

/**
 * Deny-by-default authorization. A platform-wide grant must be explicit.
 * Tenant and branch grants only match requests carrying the same scope.
 */
export function authorize(
  actor: Actor | null | undefined,
  request: AuthorizationRequest
): AuthorizationDecision {
  if (!actor?.id) return { allowed: false, reason: "missing_identity" };
  if (!actor.active) return { allowed: false, reason: "inactive_actor" };

  const candidateGrants = actor.grants.filter(
    (grant) =>
      grant.resource === request.resource && grant.actions.includes(request.action)
  );

  if (candidateGrants.length === 0) {
    return { allowed: false, reason: "missing_grant" };
  }

  if (candidateGrants.some((grant) => scopeMatches(grant.scope, request.scope))) {
    return { allowed: true, reason: "matching_grant" };
  }

  return { allowed: false, reason: "scope_mismatch" };
}
