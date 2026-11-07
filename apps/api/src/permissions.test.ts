import { describe, expect, it } from "vitest";
import { grantsForAssignments } from "./permissions.js";
import type { RoleAssignment } from "../../../packages/domain/src/identity.js";

function assignment(role: RoleAssignment["role"]): RoleAssignment {
  return {
    id: "assignment-1",
    principalId: "principal-1",
    role,
    scope: { merchantId: "merchant-1", branchId: "branch-1" },
    active: true,
    validFrom: "2026-01-01T00:00:00.000Z",
    assignedBy: "platform-admin"
  };
}

describe("merchant order permissions", () => {
  it("grants scoped read and update to owners and admins", () => {
    for (const role of ["merchant_owner", "merchant_admin"] as const) {
      const grants = grantsForAssignments([assignment(role)]);
      expect(grants).toContainEqual({
        resource: "merchant.order",
        actions: ["read", "update"],
        scope: { merchantId: "merchant-1", branchId: "branch-1" }
      });
    }
  });

  it("grants scoped read and update to branch managers", () => {
    const grants = grantsForAssignments([assignment("branch_manager")]);
    expect(grants).toContainEqual({
      resource: "merchant.order",
      actions: ["read", "update"],
      scope: { merchantId: "merchant-1", branchId: "branch-1" }
    });
  });

  it("does not grant order updates to ordinary merchant employees", () => {
    const grants = grantsForAssignments([assignment("merchant_employee")]);
    expect(grants).toContainEqual({
      resource: "merchant.order",
      actions: ["read"],
      scope: { merchantId: "merchant-1", branchId: "branch-1" }
    });
    expect(grants.some(grant => grant.resource === "merchant.order" && grant.actions.includes("update"))).toBe(false);
  });
});
