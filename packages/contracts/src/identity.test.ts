import { describe, expect, it } from "vitest";

import {
  identityLoginRequestSchema,
  identityRegisterRequestSchema,
  identitySessionStateResponseSchema,
} from "./identity.js";

describe("identity contracts", () => {
  it("normalizes email without changing password bytes", () => {
    expect(identityRegisterRequestSchema.parse({
      email: "  Creator@Example.COM ",
      password: "  long password  ",
      displayName: "  Jay  ",
    })).toEqual({
      email: "creator@example.com",
      password: "  long password  ",
      displayName: "Jay",
    });
  });

  it("rejects weak registration passwords and unknown fields", () => {
    expect(identityRegisterRequestSchema.safeParse({
      email: "creator@example.com",
      password: "short",
    }).success).toBe(false);
    expect(identityRegisterRequestSchema.safeParse({
      email: "creator@example.com",
      password: "strong-enough",
      role: "admin",
    }).success).toBe(false);
  });

  it("accepts an existing account login and an anonymous session state", () => {
    expect(identityLoginRequestSchema.parse({
      email: "CREATOR@example.com",
      password: "existing-password",
    }).email).toBe("creator@example.com");
    expect(identitySessionStateResponseSchema.parse({ ok: true, data: null })).toEqual({ ok: true, data: null });
  });
});
