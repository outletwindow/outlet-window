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
      expect(grants).toContainEqual({
        resource: "merchant.branch.inventory",
        actions: ["read", "update"],
        scope: { merchantId: "merchant-1", branchId: "branch-1" }
      });
      expect(grants).toContainEqual({
        resource: "merchant.branch.inventory_reservation",
        actions: ["execute"],
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
    expect(grants).toContainEqual({
      resource: "merchant.branch.inventory",
      actions: ["read", "update"],
      scope: { merchantId: "merchant-1", branchId: "branch-1" }
    });
    expect(grants).toContainEqual({
      resource: "merchant.branch.inventory_reservation",
      actions: ["execute"],
      scope: { merchantId: "merchant-1", branchId: "branch-1" }
    });
  });

  it("grants employees branch-scoped preparation updates but no inventory or reservation authority", () => {
    const grants = grantsForAssignments([assignment("merchant_employee")]);
    expect(grants).toContainEqual({
      resource: "merchant.order",
      actions: ["read", "update"],
      scope: { merchantId: "merchant-1", branchId: "branch-1" }
    });
    expect(grants.some(grant => grant.resource === "merchant.order" && grant.actions.includes("update"))).toBe(true);
    expect(grants.some(grant => grant.resource === "merchant.branch.inventory" && grant.actions.includes("update"))).toBe(false);
    expect(grants.some(grant => grant.resource === "merchant.branch.inventory_reservation" && grant.actions.includes("execute"))).toBe(false);
    expect(grants).toContainEqual({
      resource: "merchant.branch.inventory",
      actions: ["read"],
      scope: { merchantId: "merchant-1", branchId: "branch-1" }
    });
  });
});

describe("customer order permissions", () => {
  it("grants a customer access only to the exact order in the IAM assignment", () => {
    const customer = { ...assignment("customer"), scope: { orderId: "order-7" } };
    expect(grantsForAssignments([customer])).toEqual([{
      resource: "customer.order", actions: ["read", "update"], scope: { orderId: "order-7" }
    }]);
  });

  it("does not grant customer order access when the assignment has no order scope", () => {
    const customer = { ...assignment("customer"), scope: {} };
    expect(grantsForAssignments([customer])).toEqual([]);
  });

  it("grants cart and checkout access only to the customer ID in the IAM assignment", () => {
    const customer = { ...assignment("customer"), scope: { customerId: "principal-1" } };
    expect(grantsForAssignments([customer])).toEqual([{
      resource: "customer.cart",
      actions: ["read", "create", "delete"],
      scope: { customerId: "principal-1" }
    }]);
  });
});

describe("platform merchant settlement approval permissions", () => {
  it("grants request authority to operations and request plus approval to finance", () => {
    const operations = grantsForAssignments([assignment("operations")]);
    expect(operations).toContainEqual({
      resource: "platform.merchant_settlement", actions: ["create"], scope: { platform: true }
    });
    expect(operations.some(grant => grant.actions.includes("approve"))).toBe(false);
    const finance = grantsForAssignments([assignment("finance")]);
    expect(finance).toContainEqual({
      resource: "platform.merchant_settlement", actions: ["read", "create", "approve"], scope: { platform: true }
    });
  });

  it("grants read access to finance review queues but not operations requesters", () => {
    const finance = grantsForAssignments([assignment("finance")]);
    expect(finance.some(grant => grant.resource === "platform.merchant_settlement" && grant.actions.includes("read"))).toBe(true);
    const operations = grantsForAssignments([assignment("operations")]);
    expect(operations.some(grant => grant.resource === "platform.merchant_settlement" && grant.actions.includes("read"))).toBe(false);
  });
  it("does not grant platform settlement approval authority to merchant roles", () => {
    for (const role of ["merchant_owner", "merchant_admin", "branch_manager", "merchant_employee"] as const) {
      const grants = grantsForAssignments([assignment(role)]);
      expect(grants.some(grant => grant.resource === "platform.merchant_settlement")).toBe(false);
    }
  });
});
