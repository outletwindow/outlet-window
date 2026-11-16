import type { PermissionGrant } from "../../../packages/domain/src/authorization.js";
import type { RoleAssignment } from "../../../packages/domain/src/identity.js";

/** Maps active IAM assignments to explicit, tenant/branch-scoped API grants. */
export function grantsForAssignments(assignments: readonly RoleAssignment[]): readonly PermissionGrant[] {
  const readRoles = new Set(["merchant_owner", "merchant_admin", "branch_manager", "merchant_employee"]);
  const manageRoles = new Set(["merchant_owner", "merchant_admin"]);
  const orderManageRoles = new Set(["merchant_owner", "merchant_admin", "branch_manager"]);
  return assignments.flatMap((assignment): PermissionGrant[] => {
    // Customers may edit only the exact order explicitly present in their active IAM scope.
    if (assignment.role === "customer") {
      const grants: PermissionGrant[] = [];
      if (assignment.scope.orderId) grants.push({
        resource: "customer.order", actions: ["read", "update"], scope: { orderId: assignment.scope.orderId }
      });
      if (assignment.scope.customerId) grants.push({
        resource: "customer.cart", actions: ["read", "create", "delete"], scope: { customerId: assignment.scope.customerId }
      });
      return grants;
    }
    if (manageRoles.has(assignment.role)) return [
      { resource: "merchant.branch", actions: ["read", "create", "update"] as const, scope: assignment.scope },
      { resource: "merchant.order", actions: ["read", "update"] as const, scope: assignment.scope },
      { resource: "merchant.branch.inventory", actions: ["read", "update"] as const, scope: assignment.scope },
      { resource: "merchant.branch.inventory_reservation", actions: ["execute"] as const, scope: assignment.scope },
      { resource: "merchant.integration", actions: ["read", "create", "update"] as const, scope: assignment.scope }
    ];
    if (orderManageRoles.has(assignment.role)) return [
      { resource: "merchant.branch", actions: ["read"] as const, scope: assignment.scope },
      { resource: "merchant.order", actions: ["read", "update"] as const, scope: assignment.scope },
      { resource: "merchant.branch.inventory", actions: ["read", "update"] as const, scope: assignment.scope },
      { resource: "merchant.branch.inventory_reservation", actions: ["execute"] as const, scope: assignment.scope }
    ];
    if (assignment.role === "merchant_employee") return [
      { resource: "merchant.branch", actions: ["read"] as const, scope: assignment.scope },
      { resource: "merchant.order", actions: ["read", "update"] as const, scope: assignment.scope },
      { resource: "merchant.branch.inventory", actions: ["read"] as const, scope: assignment.scope }
    ];
    if (readRoles.has(assignment.role)) return [
      { resource: "merchant.branch", actions: ["read"] as const, scope: assignment.scope },
      { resource: "merchant.order", actions: ["read"] as const, scope: assignment.scope },
      { resource: "merchant.branch.inventory", actions: ["read"] as const, scope: assignment.scope }
    ];
    return [];
  });
}
