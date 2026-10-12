import { describe, expect, it } from "vitest";

import type { PublicMedia } from "@weftcanvas/contracts";

import { MediaServiceError } from "../media/service.js";
import { MediaGenerationInputAuthorizer } from "./input-authorizer.js";

describe("generation input authorizer", () => {
  it("checks every media id against the requesting owner and expected kind", async () => {
    const calls: Array<{ ownerId: string; mediaId: string }> = [];
    const authorizer = new MediaGenerationInputAuthorizer({
      get: async (ownerId, mediaId) => {
        calls.push({ ownerId, mediaId });
        return ready(mediaId.startsWith("image") ? "image" : "video");
      },
    });
    await expect(
      authorizer.authorize("user-1", {
        images: ["image-1", "image-2"],
        styleImages: ["image-style"],
        elementImages: ["image-element"],
        videos: ["video-1"],
        audios: [],
      }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      { ownerId: "user-1", mediaId: "image-1" },
      { ownerId: "user-1", mediaId: "image-2" },
      { ownerId: "user-1", mediaId: "image-style" },
      { ownerId: "user-1", mediaId: "image-element" },
      { ownerId: "user-1", mediaId: "video-1" },
    ]);
  });

  it("returns safe denial for missing, foreign, mismatched, or pending media", async () => {
    const missing = new MediaGenerationInputAuthorizer({
      get: async () => {
        throw new MediaServiceError("MEDIA_NOT_FOUND", "missing", 404);
      },
    });
    await expect(
      missing.authorize("user-2", { images: ["media-1"], videos: [], audios: [] }),
    ).resolves.toMatchObject({ ok: false, code: "REFERENCE_NOT_FOUND" });

    const wrongKind = new MediaGenerationInputAuthorizer({ get: async () => ready("video") });
    await expect(
      wrongKind.authorize("user-1", { images: ["media-1"], videos: [], audios: [] }),
    ).resolves.toMatchObject({ ok: false, code: "REFERENCE_NOT_READY" });

    const pending = new MediaGenerationInputAuthorizer({
      get: async () => ({ ...ready("image"), status: "pending" }),
    });
    await expect(
      pending.authorize("user-1", { images: ["media-1"], videos: [], audios: [] }),
    ).resolves.toMatchObject({ ok: false, code: "REFERENCE_NOT_READY" });
  });
});

function ready(kind: "image" | "video"): PublicMedia {
  return {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    kind,
    name: "reference",
    mimeType: kind === "image" ? "image/png" : "video/mp4",
    size: 1,
    sha256: "a".repeat(64),
    width: 1,
    height: 1,
    durationMs: kind === "video" ? 1_000 : null,
    status: "ready",
    error: null,
    createdAt: "2026-07-15T23:00:00.000Z",
    updatedAt: "2026-07-15T23:00:00.000Z",
  };
}
