import type { PermissionGrant } from "../../../packages/domain/src/authorization.js";
import type { RoleAssignment } from "../../../packages/domain/src/identity.js";

/** Maps active IAM assignments to explicit, tenant/branch-scoped API grants. */
export function grantsForAssignments(assignments: readonly RoleAssignment[]): readonly PermissionGrant[] {
  const readRoles = new Set(["merchant_owner", "merchant_admin", "branch_manager", "merchant_employee"]);
  const manageRoles = new Set(["merchant_owner", "merchant_admin"]);
  const orderManageRoles = new Set(["merchant_owner", "merchant_admin", "branch_manager"]);
  return assignments.flatMap((assignment): PermissionGrant[] => {
    // Customers may edit only the exact order explicitly present in their active IAM scope.
    if (assignment.role === "customer") return assignment.scope.orderId
      ? [{ resource: "customer.order", actions: ["read", "update"] as const, scope: { orderId: assignment.scope.orderId } }]
      : [];
    if (manageRoles.has(assignment.role)) return [
      { resource: "merchant.branch", actions: ["read", "create", "update"] as const, scope: assignment.scope },
      { resource: "merchant.order", actions: ["read", "update"] as const, scope: assignment.scope },
      { resource: "merchant.integration", actions: ["read", "create"] as const, scope: assignment.scope }
    ];
    if (orderManageRoles.has(assignment.role)) return [
      { resource: "merchant.branch", actions: ["read"] as const, scope: assignment.scope },
      { resource: "merchant.order", actions: ["read", "update"] as const, scope: assignment.scope }
    ];
    if (readRoles.has(assignment.role)) return [
      { resource: "merchant.branch", actions: ["read"] as const, scope: assignment.scope },
      { resource: "merchant.order", actions: ["read"] as const, scope: assignment.scope }
    ];
    return [];
  });
}
