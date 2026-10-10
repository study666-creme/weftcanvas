import { describe, expect, it } from "vitest";

import type { PublicMedia } from "@kachang/contracts";

import { MediaServiceError } from "../media/service.js";
import { StoredGenerationReferenceResolver } from "./reference-resolver.js";

describe("stored generation reference resolver", () => {
  it("inlines reviewed image references with owner-scoped reads", async () => {
    const calls: Array<{ ownerId: string; mediaId: string }> = [];
    const media = {
      get: async () => readyMedia("image", "image/png"),
      readReference: async (ownerId: string, mediaId: string) => {
        calls.push({ ownerId, mediaId });
        return { media: readyMedia("image", "image/png"), bytes: Buffer.from("image") };
      },
    };
    const resolver = new StoredGenerationReferenceResolver(media);

    await expect(resolver.resolve({
      ownerId: "user-1",
      mediaId: "media-1",
      kind: "image",
      format: "uri-or-data-image",
    })).resolves.toBe(`data:image/png;base64,${Buffer.from("image").toString("base64")}`);
    expect(calls).toEqual([{ ownerId: "user-1", mediaId: "media-1" }]);
  });

  it("uses short-lived signed URLs for public or non-image references", async () => {
    const media = {
      get: async () => readyMedia("video", "video/mp4"),
      readReference: async () => { throw new Error("inline read should not run"); },
    };
    const resolver = new StoredGenerationReferenceResolver(media, {
      signedAccess: { createUrl: (mediaId, kind) => `https://canvas.example/signed/${kind}/${mediaId}` },
    });
    await expect(resolver.resolve({
      ownerId: "user-1",
      mediaId: "media-1",
      kind: "video",
      format: "public-http-url",
    })).resolves.toBe("https://canvas.example/signed/video/media-1");
  });

  it("turns ownership, state, and missing delivery errors into definitive pre-submit rejection", async () => {
    const denied = new StoredGenerationReferenceResolver({
      get: async () => { throw new MediaServiceError("MEDIA_NOT_FOUND", "没有找到这个素材", 404); },
      readReference: async () => { throw new Error("unused"); },
    });
    await expect(denied.resolve({ ownerId: "user-2", mediaId: "media-1", kind: "image" }))
      .rejects.toMatchObject({ code: "MEDIA_NOT_FOUND", outcome: "rejected" });

    const noPublicUrl = new StoredGenerationReferenceResolver({
      get: async () => readyMedia("video", "video/mp4"),
      readReference: async () => { throw new Error("unused"); },
    });
    await expect(noPublicUrl.resolve({ ownerId: "user-1", mediaId: "media-1", kind: "video" }))
      .rejects.toMatchObject({ code: "REFERENCE_PUBLIC_URL_UNAVAILABLE", outcome: "rejected" });
  });
});

function readyMedia(kind: "image" | "video", mimeType: string): PublicMedia {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    kind,
    name: "reference",
    mimeType,
    size: 5,
    sha256: "a".repeat(64),
    width: kind === "image" ? 1 : 16,
    height: kind === "image" ? 1 : 9,
    durationMs: kind === "video" ? 1_000 : null,
    status: "ready",
    error: null,
    createdAt: "2026-07-15T22:00:00.000Z",
    updatedAt: "2026-07-15T22:00:00.000Z",
  };
}
