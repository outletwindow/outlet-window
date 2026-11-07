import { describe, expect, it } from "vitest";
import {
  isIdentityProfileValid,
  isRoleAssignmentActiveAt,
  isRoleAssignmentValid
} from "./identity-store.js";
import type { IdentityProfile, RoleAssignment } from "./identity.js";

const identity: IdentityProfile = {
  id: "principal-1", principalType: "human", status: "pending_verification",
  displayName: "Customer", primaryEmail: "customer@example.com",
  createdAt: "2026-11-07T09:00:00.000Z", updatedAt: "2026-11-07T09:00:00.000Z"
};

const assignment: RoleAssignment = {
  id: "role-1", principalId: "principal-1", role: "merchant_owner",
  scope: { merchantId: "merchant-1" }, active: true,
  validFrom: "2026-11-07T09:00:00.000Z",
  validUntil: "2026-12-07T09:00:00.000Z", assignedBy: "owner-1"
};

describe("identity persistence contracts", () => {
  it("accepts a valid human identity with a contact method", () => {
    expect(isIdentityProfileValid(identity)).toBe(true);
  });

  it("requires a contact method for humans and validates phone/email", () => {
    const { primaryEmail: _email, ...withoutEmail } = identity;
    expect(isIdentityProfileValid(withoutEmail)).toBe(false);
    expect(isIdentityProfileValid({ ...identity, primaryEmail: "bad-email" })).toBe(false);
    expect(isIdentityProfileValid({ ...identity, primaryPhone: "0550000000" })).toBe(false);
  });

  it("allows service principals without human contact details", () => {
    const { primaryEmail: _email, ...serviceWithoutEmail } = identity;
    expect(isIdentityProfileValid({
      ...serviceWithoutEmail, principalType: "service"
    })).toBe(true);
  });

  it("validates scoped role assignments and rejects branch without merchant", () => {
    expect(isRoleAssignmentValid(assignment)).toBe(true);
    expect(isRoleAssignmentValid({
      ...assignment, scope: { branchId: "branch-1" }
    })).toBe(false);
  });

  it("requires platform scope to be explicit and unambiguous", () => {
    expect(isRoleAssignmentValid({
      ...assignment, scope: { platform: true }
    })).toBe(true);
    expect(isRoleAssignmentValid({
      ...assignment, scope: { platform: true, merchantId: "merchant-1" }
    })).toBe(false);
    expect(isRoleAssignmentValid({
      ...assignment, scope: {}
    })).toBe(false);
  });

  it("checks role validity windows as half-open intervals", () => {
    expect(isRoleAssignmentActiveAt(assignment, "2026-11-07T09:00:00.000Z")).toBe(true);
    expect(isRoleAssignmentActiveAt(assignment, "2026-12-07T09:00:00.000Z")).toBe(false);
    expect(isRoleAssignmentActiveAt({ ...assignment, active: false }, "2026-11-08T09:00:00.000Z")).toBe(false);
  });
});
