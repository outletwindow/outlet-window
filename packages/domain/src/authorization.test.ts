import { describe, expect, it } from "vitest";
import { authorize, type Actor } from "./authorization.js";

const merchantActor: Actor = {
  id: "user-1",
  role: "merchant_owner",
  active: true,
  grants: [
    {
      resource: "inventory",
      actions: ["read", "update"],
      scope: { merchantId: "merchant-1", branchId: "branch-1" }
    }
  ]
};

describe("server-side authorization", () => {
  it("allows an explicitly granted action within the same branch", () => {
    expect(
      authorize(merchantActor, {
        resource: "inventory",
        action: "update",
        scope: { merchantId: "merchant-1", branchId: "branch-1" }
      }).allowed
    ).toBe(true);
  });

  it("denies cross-merchant access", () => {
    expect(
      authorize(merchantActor, {
        resource: "inventory",
        action: "read",
        scope: { merchantId: "merchant-2", branchId: "branch-1" }
      })
    ).toEqual({ allowed: false, reason: "scope_mismatch" });
  });

  it("denies access to another branch", () => {
    expect(
      authorize(merchantActor, {
        resource: "inventory",
        action: "read",
        scope: { merchantId: "merchant-1", branchId: "branch-2" }
      }).allowed
    ).toBe(false);
  });

  it("denies actions that were not granted", () => {
    expect(
      authorize(merchantActor, {
        resource: "inventory",
        action: "delete",
        scope: { merchantId: "merchant-1", branchId: "branch-1" }
      })
    ).toEqual({ allowed: false, reason: "missing_grant" });
  });

  it("denies inactive actors", () => {
    expect(
      authorize({ ...merchantActor, active: false }, {
        resource: "inventory",
        action: "read",
        scope: { merchantId: "merchant-1", branchId: "branch-1" }
      })
    ).toEqual({ allowed: false, reason: "inactive_actor" });
  });

  it("denies requests without a matching scope", () => {
    expect(
      authorize(merchantActor, {
        resource: "inventory",
        action: "read",
        scope: {}
      }).allowed
    ).toBe(false);
  });

  it("denies missing identities", () => {
    expect(
      authorize(null, {
        resource: "inventory",
        action: "read",
        scope: { merchantId: "merchant-1", branchId: "branch-1" }
      })
    ).toEqual({ allowed: false, reason: "missing_identity" });
  });
  it("matches customer-specific cart scopes without allowing another customer's cart", () => {
    const customer: Actor = {
      id: "customer-1", role: "customer", active: true,
      grants: [{ resource: "customer.cart", actions: ["read"], scope: { customerId: "customer-1" } }]
    };
    expect(authorize(customer, {
      resource: "customer.cart", action: "read", scope: { customerId: "customer-1" }
    }).allowed).toBe(true);
    expect(authorize(customer, {
      resource: "customer.cart", action: "read", scope: { customerId: "customer-2" }
    })).toEqual({ allowed: false, reason: "scope_mismatch" });
  });

});
