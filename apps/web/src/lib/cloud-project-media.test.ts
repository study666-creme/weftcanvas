import type { CanvasProject } from "@weftcanvas/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cacheServerMedia: vi.fn(),
  createMediaUpload: vi.fn(),
  fetchMediaMetadata: vi.fn(),
  uploadMediaBlob: vi.fn(),
  readMedia: vi.fn(),
}));

vi.mock("./api-client", () => ({
  CanvasApiError: class CanvasApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  createMediaUpload: mocks.createMediaUpload,
  fetchMediaMetadata: mocks.fetchMediaMetadata,
  uploadMediaBlob: mocks.uploadMediaBlob,
}));
vi.mock("./media-store", () => ({
  cacheServerMedia: mocks.cacheServerMedia,
  readMedia: mocks.readMedia,
}));

import { useCanvasStore } from "../state/canvas-store";
import { CanvasApiError } from "./api-client";
import { prepareProjectMediaForCloud } from "./cloud-project-media";

describe("cloud project media preparation", () => {
  beforeEach(() => {
    mocks.cacheServerMedia.mockReset();
    mocks.createMediaUpload.mockReset();
    mocks.fetchMediaMetadata.mockReset();
    mocks.uploadMediaBlob.mockReset();
    mocks.readMedia.mockReset();
  });

  it("uploads one durable object for repeated local media references", async () => {
    const project = fixtureProject();
    useCanvasStore.getState().replaceProject(project);
    mocks.readMedia.mockResolvedValue({
      ...project.nodes[0]!.data.media,
      blob: new Blob(["image"], { type: "image/png" }),
    });
    mocks.createMediaUpload.mockResolvedValue({
      media: {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "image",
        name: "frame.png",
        mimeType: "image/png",
        size: 5,
        sha256: null,
        width: 1,
        height: 1,
        durationMs: null,
        status: "ready",
        error: null,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
      upload: null,
    });

    const prepared = await prepareProjectMediaForCloud(project);

    expect(mocks.createMediaUpload).toHaveBeenCalledTimes(1);
    expect(mocks.createMediaUpload).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id }),
    );
    expect(prepared.nodes.map((node) => node.data.media?.serverId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(useCanvasStore.getState().nodes[0]?.data.media?.serverId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("can prepare media without mutating the active canvas", async () => {
    const project = fixtureProject();
    useCanvasStore.getState().replaceProject(project);
    mocks.readMedia.mockResolvedValue({
      ...project.nodes[0]!.data.media,
      blob: new Blob(["image"], { type: "image/png" }),
    });
    mocks.createMediaUpload.mockResolvedValue({
      media: {
        id: "22222222-2222-4222-8222-222222222222",
        kind: "image",
        name: "frame.png",
        mimeType: "image/png",
        size: 5,
        sha256: null,
        width: 1,
        height: 1,
        durationMs: null,
        status: "ready",
        error: null,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
      upload: null,
    });

    const prepared = await prepareProjectMediaForCloud(project, { applyToCanvas: false });

    expect(prepared.nodes[0]?.data.media?.serverId).toBe("22222222-2222-4222-8222-222222222222");
    expect(useCanvasStore.getState().nodes[0]?.data.media?.serverId).toBeNull();
  });

  it("copies Prompt Hub generation media into Canvas storage before cloud save", async () => {
    const project = fixtureProject();
    const generated = {
      ...project.nodes[0]!.data.media!,
      id: "phm_job-result_0",
      source: "server" as const,
      serverId: "phm_job-result_0",
    };
    project.nodes.forEach((node) => {
      node.data.media = { ...generated };
    });
    useCanvasStore.getState().replaceProject(project);
    const stored = {
      ...generated,
      blob: new Blob(["image"], { type: "image/png" }),
    };
    mocks.readMedia.mockResolvedValueOnce(null).mockResolvedValue(stored);
    mocks.cacheServerMedia.mockResolvedValue(true);
    mocks.createMediaUpload.mockResolvedValue({
      media: {
        id: "33333333-3333-4333-8333-333333333333",
        kind: "image",
        name: "frame.png",
        mimeType: "image/png",
        size: 5,
        sha256: null,
        width: 1,
        height: 1,
        durationMs: null,
        status: "ready",
        error: null,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
      upload: null,
    });

    const prepared = await prepareProjectMediaForCloud(project);

    expect(mocks.cacheServerMedia).toHaveBeenCalledWith(generated);
    expect(mocks.createMediaUpload).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id }),
    );
    expect(prepared.nodes.map((node) => node.data.media?.serverId)).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(useCanvasStore.getState().nodes[0]?.data.media?.serverId).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
  });

  it("does not re-upload media already persisted by Canvas", async () => {
    const project = fixtureProject();
    project.nodes.forEach((node) => {
      node.data.media = {
        ...node.data.media!,
        source: "server",
        serverId: "44444444-4444-4444-8444-444444444444",
      };
    });
    mocks.fetchMediaMetadata.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      kind: "image",
      status: "ready",
    });

    await expect(prepareProjectMediaForCloud(project)).resolves.toEqual(project);
    expect(mocks.fetchMediaMetadata).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
      project.id,
    );
    expect(mocks.cacheServerMedia).not.toHaveBeenCalled();
    expect(mocks.readMedia).not.toHaveBeenCalled();
    expect(mocks.createMediaUpload).not.toHaveBeenCalled();
  });

  it("copies an unbound native generation result before cloud save", async () => {
    const project = fixtureProject();
    const generated = {
      ...project.nodes[0]!.data.media!,
      id: "55555555-5555-4555-8555-555555555555",
      source: "server" as const,
      serverId: "55555555-5555-4555-8555-555555555555",
    };
    project.nodes.forEach((node) => {
      node.data.media = { ...generated };
    });
    mocks.fetchMediaMetadata.mockRejectedValue(
      new CanvasApiError(404, "MEDIA_NOT_FOUND", "missing"),
    );
    const stored = { ...generated, blob: new Blob(["image"], { type: "image/png" }) };
    mocks.readMedia.mockResolvedValueOnce(null).mockResolvedValue(stored);
    mocks.cacheServerMedia.mockResolvedValue(true);
    mocks.createMediaUpload.mockResolvedValue({
      media: {
        id: "66666666-6666-4666-8666-666666666666",
        kind: "image",
        name: "frame.png",
        mimeType: "image/png",
        size: 5,
        sha256: null,
        width: 1,
        height: 1,
        durationMs: null,
        status: "ready",
        error: null,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
      upload: null,
    });

    const prepared = await prepareProjectMediaForCloud(project);

    expect(mocks.cacheServerMedia).toHaveBeenCalledWith(generated);
    expect(mocks.createMediaUpload).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id }),
    );
    expect(prepared.nodes[0]?.data.media?.serverId).toBe("66666666-6666-4666-8666-666666666666");
  });
});

function fixtureProject(): CanvasProject {
  const media = {
    id: "local-media",
    name: "frame.png",
    mimeType: "image/png",
    size: 5,
    source: "local" as const,
    serverId: null,
    width: 1,
    height: 1,
    durationMs: null,
  };
  return {
    schemaVersion: 1,
    id: "project-cloud-media",
    name: "Media",
    nodes: [node("node-1", media), node("node-2", media)],
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: 1,
    updatedAt: 1,
  };
}

function node(
  id: string,
  media: NonNullable<CanvasProject["nodes"][number]["data"]["media"]>,
): CanvasProject["nodes"][number] {
  return {
    id,
    type: "weftcanvas",
    position: { x: 0, y: 0 },
    data: {
      kind: "image",
      body: "",
      accent: "jade",
      status: "success",
      progress: null,
      media: { ...media },
      directorCapture: null,
      config: null,
      edit: null,
      music: null,
      generation: {
        modelId: null,
        parameters: {},
        referenceImagePurposes: {},
        maxOutputTokens: null,
        referenceMode: "auto",
        referenceNodeIds: [],
        jobId: null,
        jobVersion: null,
        jobCreatedAt: null,
        jobStatus: null,
        error: null,
      },
      createdAt: 1,
      updatedAt: 1,
    },
  };
}
