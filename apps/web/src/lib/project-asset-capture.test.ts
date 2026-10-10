import type { CanvasMedia } from "@kachang/contracts";
import { describe, expect, it } from "vitest";
import type { KachangNode } from "../types";

import {
  collectCanvasMediaCaptures,
  projectAssetDisplayName,
  projectAssetKindOfMedia,
} from "./project-asset-capture";

function media(id: string, mimeType: string): CanvasMedia {
  return {
    id,
    name: `${id}.bin`,
    mimeType,
    size: 1024,
    source: "local",
    serverId: null,
    width: null,
    height: null,
    durationMs: null,
  };
}

function node(id: string, data: Partial<KachangNode["data"]>): KachangNode {
  return {
    id,
    type: "kachang",
    position: { x: 0, y: 0 },
    data: {
      kind: "image",
      body: "",
      status: "success",
      progress: null,
      media: null,
      uploading: false,
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
      ...data,
    } as KachangNode["data"],
  };
}

describe("project asset kind detection", () => {
  it("maps media mime types to asset kinds and rejects unknown types", () => {
    expect(projectAssetKindOfMedia(media("m1", "image/png"))).toBe("image");
    expect(projectAssetKindOfMedia(media("m2", "video/mp4"))).toBe("video");
    expect(projectAssetKindOfMedia(media("m3", "audio/wav"))).toBe("audio");
    expect(projectAssetKindOfMedia(media("m4", "application/pdf"))).toBeNull();
  });
});

describe("collectCanvasMediaCaptures", () => {
  it("collects one capture per media id with the node prompt attached", () => {
    const captures = collectCanvasMediaCaptures([
      node("n1", { media: media("a", "image/png"), body: "赛博朋克城市夜景" }),
      node("n2", { media: media("b", "video/mp4"), body: " 固定镜头  " }),
    ]);

    expect(captures).toHaveLength(2);
    expect(captures[0]).toMatchObject({ kind: "image", prompt: "赛博朋克城市夜景" });
    expect(captures[1]).toMatchObject({ kind: "video", prompt: "固定镜头" });
  });

  it("keeps only the first node when the same media is reused across nodes", () => {
    const captures = collectCanvasMediaCaptures([
      node("n1", { media: media("a", "image/png"), body: "第一个" }),
      node("n2", { media: media("a", "image/png"), body: "第二个" }),
    ]);

    expect(captures).toHaveLength(1);
    expect(captures[0]?.prompt).toBe("第一个");
  });

  it("skips nodes without media or with unsupported media types", () => {
    const captures = collectCanvasMediaCaptures([
      node("n1", { body: "纯文本" }),
      node("n2", { media: media("p", "application/json") }),
    ]);

    expect(captures).toHaveLength(0);
  });
});

describe("projectAssetDisplayName", () => {
  it("prefers the prompt and falls back to the media file name", () => {
    expect(projectAssetDisplayName("女主 主角 立绘", media("a", "image/png"))).toBe("女主 主角 立绘");
    expect(projectAssetDisplayName("   ", media("a", "image/png"))).toBe("a.bin");
  });
});
