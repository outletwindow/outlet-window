import { describe, expect, it } from "vitest";
import {
  canTransitionAccount,
  isSessionDescriptorValid,
  type SessionDescriptor
} from "./identity.js";

const session: SessionDescriptor = {
  id: "session-1",
  principalId: "principal-1",
  createdAt: "2026-11-07T10:00:00.000Z",
  expiresAt: "2026-11-07T11:00:00.000Z",
  lastSeenAt: "2026-11-07T10:30:00.000Z",
  authenticationMethods: ["passkey", "mfa"]
};

describe("identity contracts", () => {
  it("allows valid account lifecycle transitions", () => {
    expect(canTransitionAccount("pending_verification", "active")).toBe(true);
    expect(canTransitionAccount("active", "suspended")).toBe(true);
  });

  it("rejects invalid lifecycle transitions", () => {
    expect(canTransitionAccount("deletion_requested", "active")).toBe(false);
    expect(canTransitionAccount("closed", "active")).toBe(false);
  });

  it("accepts a valid human session descriptor", () => {
    expect(isSessionDescriptorValid("human", session)).toBe(true);
  });

  it("rejects human authentication methods for service principals", () => {
    expect(isSessionDescriptorValid("service", session)).toBe(false);
  });

  it("rejects expired or malformed session windows", () => {
    expect(isSessionDescriptorValid("human", {
      ...session,
      expiresAt: session.createdAt
    })).toBe(false);
  });
});
