import { describe, expect, it } from "vitest";

import {
  canUseCanvasApi,
  canvasApiAccessLabel,
  hasCanvasApiMembership,
  resolveCanvasApiAccess,
} from "./canvas-api-access";

describe("Canvas API access", () => {
  it.each(["standard", "pro", "professional", "premium", "plus"])(
    "recognizes active %s membership as eligible",
    (tier) => {
      expect(hasCanvasApiMembership({ active: true, tier })).toBe(true);
    },
  );

  it.each([
    { active: false, tier: "standard" },
    { active: true, tier: "basic" },
    { active: true, tier: "lite" },
    { active: true, tier: null },
    null,
    undefined,
  ])("does not treat inactive or lower tiers as eligible: %o", (membership) => {
    expect(hasCanvasApiMembership(membership)).toBe(false);
  });

  it("keeps authenticated users in the free preview until the policy flips", () => {
    expect(
      resolveCanvasApiAccess({ authenticated: true, membership: { active: true, tier: "basic" } }),
    ).toMatchObject({
      allowed: true,
      memberEligible: false,
      source: "preview",
    });
  });

  it("keeps anonymous BYOK local access independent of membership", () => {
    expect(resolveCanvasApiAccess({ authenticated: false, previewEnabled: false })).toMatchObject({
      allowed: true,
      source: "local",
    });
  });

  it("provides one switchable gate for a future paid rollout", () => {
    expect(
      canUseCanvasApi({
        authenticated: true,
        membership: { active: true, tier: "basic" },
        previewEnabled: false,
      }),
    ).toBe(false);
    expect(
      canUseCanvasApi({
        authenticated: true,
        membership: { active: true, tier: "standard" },
        previewEnabled: false,
      }),
    ).toBe(true);
  });

  it("supports the membership-only settings projection", () => {
    expect(resolveCanvasApiAccess({ active: true, tier: "standard" })).toMatchObject({
      allowed: true,
      memberEligible: true,
      source: "membership",
    });
    expect(canUseCanvasApi(null)).toBe(true);
  });

  it("keeps the entitlement label stable for the settings UI", () => {
    expect(canvasApiAccessLabel({ allowed: true, memberEligible: false })).toContain("当前限免");
    expect(canvasApiAccessLabel({ allowed: true, memberEligible: true })).toBe("标准会员权益");
    expect(canvasApiAccessLabel({ allowed: false, memberEligible: false })).toBe("需要标准会员");
  });
});
