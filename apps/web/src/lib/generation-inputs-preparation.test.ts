import type { CanvasMedia, PublicModel } from "@weftcanvas/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WeftcanvasNode } from "../types";

const mocks = vi.hoisted(() => ({
  createMediaUpload: vi.fn(),
  createProviderMediaReference: vi.fn(),
  uploadMediaBlob: vi.fn(),
  cacheServerMedia: vi.fn(),
  readMedia: vi.fn(),
  updateNodeData: vi.fn(),
  projectId: "local-project",
}));

vi.mock("./api-client", () => ({
  createMediaUpload: mocks.createMediaUpload,
  createProviderMediaReference: mocks.createProviderMediaReference,
  uploadMediaBlob: mocks.uploadMediaBlob,
}));

vi.mock("./media-store", () => ({
  cacheServerMedia: mocks.cacheServerMedia,
  readMedia: mocks.readMedia,
}));

vi.mock("../state/canvas-store", () => ({
  useCanvasStore: {
    getState: () => ({
      projectId: mocks.projectId,
      nodes: [],
      updateNodeData: mocks.updateNodeData,
    }),
  },
}));

import { useCloudProjectStore } from "../state/cloud-project-store";
import {
  collectGenerationReferences,
  prepareCustomGenerationInputs,
  prepareGenerationInputs,
  type GenerationReferences,
} from "./generation-inputs";

describe("prepareGenerationInputs", () => {
  beforeEach(() => {
    mocks.createMediaUpload.mockReset();
    mocks.createProviderMediaReference.mockReset();
    mocks.uploadMediaBlob.mockReset();
    mocks.cacheServerMedia.mockReset();
    mocks.readMedia.mockReset();
    mocks.updateNodeData.mockReset();
    mocks.cacheServerMedia.mockResolvedValue(false);
    mocks.projectId = "local-project";
    useCloudProjectStore.setState({ links: {} });
  });

  it("uploads cached generated media instead of reopening its provider result", async () => {
    const media = serverMedia("generated-image");
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    mocks.readMedia.mockResolvedValue({ ...media, blob, storedAt: Date.now() });
    mocks.createMediaUpload.mockResolvedValue({
      media: { id: "durable-reference", status: "pending" },
      upload: { url: "/api/v1/media/durable-reference/content", method: "PUT", headers: {} },
    });
    mocks.uploadMediaBlob.mockResolvedValue({ id: "durable-reference", status: "ready" });

    const inputs = await prepareGenerationInputs(references(media));

    expect(inputs.images).toEqual(["durable-reference"]);
    expect(mocks.createMediaUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "image",
        name: media.name,
        mimeType: "image/png",
        size: 3,
      }),
    );
    expect(mocks.uploadMediaBlob).toHaveBeenCalledWith(
      expect.objectContaining({ id: "durable-reference" }),
      expect.any(Object),
      blob,
    );
  });

  it("falls back to the owner-scoped server media id when no browser cache exists", async () => {
    const media = serverMedia("uncached-image");
    mocks.readMedia.mockResolvedValue(null);

    const inputs = await prepareGenerationInputs(references(media));

    expect(inputs.images).toEqual([media.id]);
    expect(mocks.cacheServerMedia).toHaveBeenCalledWith(media);
    expect(mocks.createMediaUpload).not.toHaveBeenCalled();
    expect(mocks.uploadMediaBlob).not.toHaveBeenCalled();
  });

  it("waits for an in-flight server media cache before preparing a durable reference", async () => {
    const media = serverMedia("caching-image");
    const blob = new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" });
    mocks.readMedia
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...media, blob, storedAt: Date.now() });
    mocks.cacheServerMedia.mockResolvedValue(true);
    mocks.createMediaUpload.mockResolvedValue({
      media: { id: "cached-reference", status: "pending" },
      upload: { url: "/api/v1/media/cached-reference/content", method: "PUT", headers: {} },
    });
    mocks.uploadMediaBlob.mockResolvedValue({ id: "cached-reference", status: "ready" });

    const inputs = await prepareGenerationInputs(references(media));

    expect(inputs.images).toEqual(["cached-reference"]);
    expect(mocks.cacheServerMedia).toHaveBeenCalledWith(media);
    expect(mocks.readMedia).toHaveBeenCalledTimes(2);
  });

  it("reuses an already uploaded durable reference without reading IndexedDB", async () => {
    const media = { ...serverMedia("generated-image"), serverId: "durable-reference" };

    const inputs = await prepareGenerationInputs(references(media));

    expect(inputs.images).toEqual(["durable-reference"]);
    expect(mocks.readMedia).not.toHaveBeenCalled();
  });

  it("re-uploads cached bytes when the server rejected the stored reference", async () => {
    // 服务端回「素材不存在」之后：forceUpload 不能再信 serverId，把浏览器里缓存的
    // 那份字节重新上传成当前项目的素材，再提交一次。
    const media = { ...serverMedia("generated-image"), serverId: "stale-server-id" };
    const blob = new Blob([new Uint8Array([7, 8, 9])], { type: "image/png" });
    mocks.readMedia.mockResolvedValue({ ...media, blob, storedAt: Date.now() });
    mocks.createMediaUpload.mockResolvedValue({
      media: { id: "recovered-reference", status: "pending" },
      upload: { url: "/api/v1/media/recovered-reference/content", method: "PUT", headers: {} },
    });
    mocks.uploadMediaBlob.mockResolvedValue({ id: "recovered-reference", status: "ready" });

    // 正常路径仍然直接复用已经上传过的 serverId，不读本地缓存。
    await expect(prepareGenerationInputs(references(media))).resolves.toMatchObject({
      images: ["stale-server-id"],
    });
    await expect(
      prepareGenerationInputs(references(media), { forceUpload: true }),
    ).resolves.toMatchObject({ images: ["recovered-reference"] });
  });

  it("tells the user to re-upload when neither the server nor the browser has the bytes", async () => {
    const media = { ...serverMedia("gone-image"), serverId: "gone-server-id" };
    mocks.readMedia.mockResolvedValue(null);

    await expect(prepareGenerationInputs(references(media), { forceUpload: true })).rejects.toThrow(
      /素材在服务器上已不存在/,
    );
  });

  it("converts custom API references to provider-accessible HTTPS URLs when required", async () => {
    const media = { ...serverMedia("generated-image"), serverId: "durable-reference" };
    mocks.createProviderMediaReference.mockResolvedValue(
      "https://media.example/signed-reference.png",
    );

    const inputs = await prepareCustomGenerationInputs(references(media), new Set(["image"]));

    expect(inputs.images).toEqual(["https://media.example/signed-reference.png"]);
    expect(mocks.createProviderMediaReference).toHaveBeenCalledWith("durable-reference", "image");
    expect(mocks.readMedia).not.toHaveBeenCalled();
  });

  it("preserves style and element image buckets through hosted and custom preparation", async () => {
    const styleMedia = { ...serverMedia("style-image"), serverId: "durable-style" };
    const elementMedia = { ...serverMedia("element-image"), serverId: "durable-element" };
    mocks.createProviderMediaReference.mockResolvedValue("https://media.example/element.png");

    const hosted = await prepareGenerationInputs(references(styleMedia, "styleImages"));
    const custom = await prepareCustomGenerationInputs(
      references(elementMedia, "elementImages"),
      new Set(["image"]),
    );

    expect(hosted).toEqual({
      images: [],
      styleImages: ["durable-style"],
      elementImages: [],
      videos: [],
      audios: [],
    });
    expect(custom).toEqual({
      images: [],
      styleImages: [],
      elementImages: ["https://media.example/element.png"],
      videos: [],
      audios: [],
    });
    expect(mocks.createProviderMediaReference).toHaveBeenCalledWith("durable-element", "image");
  });

  it("starts every independent reference bucket before waiting for uploads", async () => {
    const bucketMedia = [
      ["image", "image"],
      ["style", "image"],
      ["element", "image"],
      ["video", "video"],
      ["audio", "audio"],
    ] as const;
    const refs = bucketMedia.map(([id, kind]) => ({
      nodeId: `${id}-node`,
      kind,
      media: serverMedia(id),
    }));
    const [imageRef, styleRef, elementRef, videoRef, audioRef] = refs;
    const resolvers = new Map<string, (value: unknown) => void>();
    mocks.readMedia.mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          resolvers.set(id, resolve);
        }),
    );
    mocks.createMediaUpload.mockImplementation(({ name }: { name: string }) =>
      Promise.resolve({
        media: { id: `ready-${name}`, status: "ready" },
        upload: null,
      }),
    );

    const pending = prepareGenerationInputs({
      images: [imageRef!],
      styleImages: [styleRef!],
      elementImages: [elementRef!],
      videos: [videoRef!],
      audios: [audioRef!],
      connectedImages: [imageRef!, styleRef!, elementRef!],
      unassignedImages: [],
      imagePurposes: ["images", "styleImages", "elementImages"],
      overflow: [],
      aggregateOverflow: null,
    });

    expect([...resolvers.keys()]).toEqual(["image", "style", "element", "video", "audio"]);
    for (const [id] of bucketMedia) {
      const media = serverMedia(id);
      resolvers.get(id)?.({ ...media, blob: new Blob([id]), storedAt: Date.now() });
    }

    await expect(pending).resolves.toEqual({
      images: ["ready-image.png"],
      styleImages: ["ready-style.png"],
      elementImages: ["ready-element.png"],
      videos: ["ready-video.png"],
      audios: ["ready-audio.png"],
    });
  });

  it("copies shared-project media into the collaborator's personal scope for generation", async () => {
    const media = serverMedia("owner-project-media");
    const blob = new Blob([new Uint8Array([7, 8, 9])], { type: "image/png" });
    mocks.projectId = "shared-project";
    useCloudProjectStore.setState({
      links: {
        "shared-project": {
          ownerId: "collaborator-1",
          projectOwnerId: "owner-1",
          projectId: "shared-project",
          revision: 1,
          lastSyncedFingerprint: "fingerprint",
        },
      },
    });
    mocks.readMedia
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...media, blob, storedAt: Date.now() });
    mocks.cacheServerMedia.mockResolvedValue(true);
    mocks.createMediaUpload.mockResolvedValue({
      media: { id: "collaborator-personal-reference", status: "pending" },
      upload: {
        url: "/api/v1/media/collaborator-personal-reference/content",
        method: "PUT",
        headers: {},
      },
    });
    mocks.uploadMediaBlob.mockResolvedValue({
      id: "collaborator-personal-reference",
      status: "ready",
    });

    const inputs = await prepareGenerationInputs(references(media));

    expect(inputs.images).toEqual(["collaborator-personal-reference"]);
    expect(mocks.cacheServerMedia).toHaveBeenCalledWith(media, "shared-project");
    expect(mocks.createMediaUpload).toHaveBeenCalledWith(
      expect.not.objectContaining({ projectId: expect.anything() }),
    );
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });

  it("creates public provider references from the collaborator's personal copy", async () => {
    const media = serverMedia("owner-project-media");
    const blob = new Blob([new Uint8Array([7, 8, 9])], { type: "image/png" });
    mocks.projectId = "shared-project";
    useCloudProjectStore.setState({
      links: {
        "shared-project": {
          ownerId: "collaborator-1",
          projectOwnerId: "owner-1",
          projectId: "shared-project",
          revision: 1,
          lastSyncedFingerprint: "fingerprint",
        },
      },
    });
    mocks.readMedia
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...media, blob, storedAt: Date.now() });
    mocks.cacheServerMedia.mockResolvedValue(true);
    mocks.createMediaUpload.mockResolvedValue({
      media: { id: "collaborator-personal-reference", status: "pending" },
      upload: {
        url: "/api/v1/media/collaborator-personal-reference/content",
        method: "PUT",
        headers: {},
      },
    });
    mocks.uploadMediaBlob.mockResolvedValue({
      id: "collaborator-personal-reference",
      status: "ready",
    });
    mocks.createProviderMediaReference.mockResolvedValue(
      "https://media.example/collaborator-reference.png",
    );

    const inputs = await prepareCustomGenerationInputs(references(media), new Set(["image"]));

    expect(inputs.images).toEqual(["https://media.example/collaborator-reference.png"]);
    expect(mocks.createProviderMediaReference).toHaveBeenCalledWith(
      "collaborator-personal-reference",
      "image",
    );
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
  });

  it("prepares only the allowed images when a Grok-like video model rejects video references", async () => {
    const model = {
      id: "grok-video-fixture",
      modality: "video",
      input: {
        textRequired: true,
        referenceMedia: { images: { min: 0, max: 4, multiple: true } },
      },
    } as PublicModel;
    const imageMedia = { ...serverMedia("frame-a"), serverId: "durable-frame" };
    mocks.createProviderMediaReference.mockResolvedValue("https://media.example/frame-a.png");
    const references = collectGenerationReferences(
      "target",
      model,
      [
        node("target", "video", serverMedia("target-video")),
        node("frame-a", "image", imageMedia),
        node("reference-video", "video", serverMedia("reference-video")),
      ],
      [
        { id: "edge-frame", source: "frame-a", target: "target" },
        { id: "edge-video", source: "reference-video", target: "target" },
      ],
    );

    const inputs = await prepareCustomGenerationInputs(references, new Set(["image"]));

    expect(inputs).toEqual({
      images: ["https://media.example/frame-a.png"],
      styleImages: [],
      elementImages: [],
      videos: [],
      audios: [],
    });
    expect(mocks.createProviderMediaReference).toHaveBeenCalledWith("durable-frame", "image");
  });
});

function serverMedia(id: string): CanvasMedia {
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    size: 3,
    source: "server",
    serverId: id,
    width: 1,
    height: 1,
    durationMs: null,
  };
}

function node(
  id: string,
  kind: "text" | "image" | "video" | "audio",
  nodeMedia: CanvasMedia | null,
): WeftcanvasNode {
  return {
    id,
    type: "weftcanvas",
    position: { x: 0, y: 0 },
    data: {
      kind,
      body: "",
      accent: "jade",
      status: nodeMedia ? "success" : "idle",
      progress: null,
      media: nodeMedia,
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

function references(
  media: CanvasMedia,
  purpose: "images" | "styleImages" | "elementImages" = "images",
): GenerationReferences {
  const reference = { nodeId: "image-node", kind: "image" as const, media };
  return {
    images: purpose === "images" ? [reference] : [],
    styleImages: purpose === "styleImages" ? [reference] : [],
    elementImages: purpose === "elementImages" ? [reference] : [],
    videos: [],
    audios: [],
    connectedImages: [reference],
    unassignedImages: [],
    imagePurposes: [purpose],
    overflow: [],
    aggregateOverflow: null,
  };
}
