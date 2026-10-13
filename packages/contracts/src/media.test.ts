import { describe, expect, it } from "vitest";

import {
  cloudResourceCleanupRequestSchema,
  mediaUploadInstructionSchema,
  mediaUploadRequestSchema,
  publicMediaSchema,
} from "./media.js";

describe("media contracts", () => {
  it("normalizes upload metadata and accepts an integrity digest", () => {
    expect(
      mediaUploadRequestSchema.parse({
        kind: "image",
        name: "  reference.png  ",
        mimeType: "IMAGE/PNG",
        size: 1024,
        sha256: "A".repeat(64),
        idempotencyKey: "upload:one",
      }),
    ).toMatchObject({
      name: "reference.png",
      mimeType: "image/png",
      sha256: "a".repeat(64),
    });
  });

  it("rejects zero-byte files, malformed media types, and unknown fields", () => {
    expect(
      mediaUploadRequestSchema.safeParse({
        kind: "video",
        name: "clip.mp4",
        mimeType: "video/mp4; charset=utf-8",
        size: 0,
        idempotencyKey: "upload:two",
      }).success,
    ).toBe(false);
    expect(
      mediaUploadRequestSchema.safeParse({
        kind: "video",
        name: "clip.mp4",
        mimeType: "video/mp4",
        size: 10,
        idempotencyKey: "upload:two",
        objectKey: "private/path",
      }).success,
    ).toBe(false);
  });

  it("keeps storage paths and ownership out of public media", () => {
    const parsed = publicMediaSchema.parse({
      id: "55555555-5555-4555-8555-555555555555",
      ownerId: "private-owner",
      objectKey: "private/path",
      kind: "image",
      name: "result.png",
      mimeType: "image/png",
      size: 1024,
      sha256: null,
      width: null,
      height: null,
      durationMs: null,
      status: "pending",
      error: null,
      createdAt: "2026-07-15T15:00:00.000Z",
      updatedAt: "2026-07-15T15:00:00.000Z",
    });
    expect(parsed).not.toHaveProperty("ownerId");
    expect(parsed).not.toHaveProperty("objectKey");
  });

  it("makes direct-upload completion explicit", () => {
    expect(
      mediaUploadInstructionSchema.parse({
        method: "PUT",
        url: "https://objects.example.test/capability",
        headers: { "Content-Type": "image/png" },
        expiresAt: "2026-07-15T15:15:00.000Z",
        completeUrl: "/api/v1/media/55555555-5555-4555-8555-555555555555/complete",
      }),
    ).toMatchObject({ completeUrl: expect.stringContaining("/complete") });
  });

  it("accepts an explicit forceUnbound flag on cloud resource cleanup", () => {
    expect(
      cloudResourceCleanupRequestSchema.parse({
        mediaIds: ["55555555-5555-4555-8555-555555555555"],
        forceUnbound: true,
      }),
    ).toEqual({
      mediaIds: ["55555555-5555-4555-8555-555555555555"],
      forceUnbound: true,
    });
    expect(
      cloudResourceCleanupRequestSchema.parse({
        mediaIds: ["55555555-5555-4555-8555-555555555555"],
      }),
    ).not.toHaveProperty("forceUnbound");
    expect(() =>
      cloudResourceCleanupRequestSchema.parse({
        mediaIds: ["55555555-5555-4555-8555-555555555555"],
        forceUnbound: "yes",
      }),
    ).toThrow();
  });
});
