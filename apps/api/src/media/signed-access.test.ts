import { describe, expect, it } from "vitest";

import { SignedMediaAccess } from "./signed-access.js";

const NOW = Date.parse("2026-07-15T22:00:00.000Z");
const SECRET = "test-secret-with-at-least-thirty-two-bytes";

describe("signed media access", () => {
  it("creates a bounded URL and verifies its exact media identity", () => {
    const access = new SignedMediaAccess({
      secret: SECRET,
      baseUrl: "http://127.0.0.1:8787",
      allowInsecureLocalhost: true,
      now: () => NOW,
      ttlSeconds: 60,
      maxTtlSeconds: 120,
    });
    const signed = new URL(access.createUrl("media-1", "video"));

    expect(signed.origin).toBe("http://127.0.0.1:8787");
    expect(access.verify(
      "media-1",
      "video",
      signed.searchParams.get("expires") ?? undefined,
      signed.searchParams.get("signature") ?? undefined,
    )).toBe(true);
    expect(access.verify(
      "media-2",
      "video",
      signed.searchParams.get("expires") ?? undefined,
      signed.searchParams.get("signature") ?? undefined,
    )).toBe(false);
    expect(access.verify(
      "media-1",
      "image",
      signed.searchParams.get("expires") ?? undefined,
      signed.searchParams.get("signature") ?? undefined,
    )).toBe(false);
  });

  it("rejects expired, overlong, tampered, and insecure public URLs", () => {
    expect(() => new SignedMediaAccess({ secret: "short" })).toThrow("32");
    expect(() => new SignedMediaAccess({ secret: SECRET, baseUrl: "http://public.example" })).toThrow("HTTPS");

    const access = new SignedMediaAccess({ secret: SECRET, now: () => NOW, ttlSeconds: 60, maxTtlSeconds: 120 });
    expect(access.verify("media-1", "image", String(Math.floor(NOW / 1_000)), "A".repeat(43))).toBe(false);
    expect(access.verify("media-1", "image", String(Math.floor(NOW / 1_000) + 121), "A".repeat(43))).toBe(false);
    expect(access.verify("media-1", "image", String(Math.floor(NOW / 1_000) + 60), "bad")).toBe(false);
  });
});
