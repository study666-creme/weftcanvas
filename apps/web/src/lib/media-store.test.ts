import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMediaUpload: vi.fn(),
  uploadMediaBlob: vi.fn(),
  validateImageBlob: vi.fn(),
}));

vi.mock("./api-client", () => ({
  createMediaUpload: mocks.createMediaUpload,
  createRequestKey: (prefix: string) => `${prefix}:test-key`,
  mediaContentPath: (mediaId: string, projectId?: string) =>
    `/api/v1/media/${mediaId}/content${projectId ? `?projectId=${projectId}` : ""}`,
  uploadMediaBlob: mocks.uploadMediaBlob,
}));

vi.mock("./media-validation", () => ({
  validateImageBlob: mocks.validateImageBlob,
  validateMediaBlob: vi.fn(),
}));

import { localMediaMaxBytes, shouldPruneLocalMedia, uploadMediaToServer } from "./media-store";

describe("local media size limits", () => {
  it("matches the reviewed server upload boundaries exactly", () => {
    expect(localMediaMaxBytes).toEqual({
      image: 25 * 1024 * 1024,
      video: 512 * 1024 * 1024,
      audio: 100 * 1024 * 1024,
    });
  });
});

describe("local media pruning", () => {
  it("protects newly stored media while project persistence catches up", () => {
    const now = 100_000;
    const retained = new Set(["media-kept"]);

    expect(
      shouldPruneLocalMedia({ id: "media-recent", storedAt: now - 1_000 }, retained, now),
    ).toBe(false);
    expect(shouldPruneLocalMedia({ id: "media-old", storedAt: now - 60_000 }, retained, now)).toBe(
      true,
    );
    expect(shouldPruneLocalMedia({ id: "media-kept", storedAt: 0 }, retained, now)).toBe(false);
    expect(shouldPruneLocalMedia({ id: "media-legacy" }, retained, now)).toBe(true);
  });
});

describe("uploadMediaToServer fallback", () => {
  const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });

  it("maps a ready server upload onto a canvas server media record", async () => {
    mocks.validateImageBlob.mockResolvedValue({
      blob: file,
      mimeType: "image/png",
      width: 640,
      height: 480,
      durationMs: undefined,
    });
    mocks.createMediaUpload.mockResolvedValue({
      media: { id: "srv-1", status: "uploading", error: null },
      upload: {
        method: "PUT",
        url: "https://r2.test/put",
        headers: {},
        completeUrl: null,
        expiresAt: "2026-01-01T00:00:00Z",
      },
    });
    mocks.uploadMediaBlob.mockResolvedValue({
      id: "srv-1",
      name: "photo.png",
      mimeType: "image/png",
      size: 3,
      width: 640,
      height: 480,
      durationMs: null,
      status: "ready",
      error: null,
    });

    const media = await uploadMediaToServer(file, "image");

    expect(media).toEqual({
      id: "srv-1",
      name: "photo.png",
      mimeType: "image/png",
      size: 3,
      source: "server",
      serverId: "srv-1",
      width: 640,
      height: 480,
      durationMs: null,
    });
    expect(mocks.createMediaUpload).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "image", mimeType: "image/png", size: 3 }),
    );
    expect(mocks.createMediaUpload).not.toHaveBeenCalledWith(
      expect.objectContaining({ projectId: expect.anything() }),
    );
  });

  it("forwards the cloud project scope into the upload intent", async () => {
    mocks.validateImageBlob.mockResolvedValue({
      blob: file,
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
    mocks.createMediaUpload.mockResolvedValue({
      media: { id: "srv-3", status: "ready", error: null },
      upload: null,
    });

    await uploadMediaToServer(file, "image", "project-cloud");

    expect(mocks.createMediaUpload).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-cloud" }),
    );
  });

  it("surfaces the server-side failure message instead of a generic error", async () => {
    mocks.validateImageBlob.mockResolvedValue({
      blob: file,
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
    mocks.createMediaUpload.mockResolvedValue({
      media: { id: "srv-2", status: "uploading", error: null },
      upload: null,
    });

    await expect(uploadMediaToServer(file, "image")).rejects.toThrow("素材上传失败，请稍后重试");
  });
});
