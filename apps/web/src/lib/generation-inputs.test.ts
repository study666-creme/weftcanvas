import type { CanvasMedia, PublicModel } from "@kachang/contracts";
import { describe, expect, it } from "vitest";

import type { KachangNode } from "../types";
import {
  collectGenerationReferences,
  collectUpstreamTextContent,
  composeReferenceAwarePrompt,
  generationReferenceError,
  referenceCounts,
  referenceVideoDurations,
} from "./generation-inputs";

describe("collectGenerationReferences", () => {
  it("uses only explicit references and preserves their order", () => {
    const nodes = [
      node("target", "video"),
      node("explicit-a", "image", media("explicit-a-media")),
      node("explicit-b", "image", media("explicit-b-media")),
      node("upstream", "image", media("upstream-media")),
    ];

    const references = collectGenerationReferences(
      "target",
      imageInputModel(3),
      nodes,
      edgesToTarget(["explicit-a", "explicit-b", "upstream"]),
      ["explicit-b", "explicit-a"],
    );

    expect(references.images.map((reference) => reference.nodeId)).toEqual(["explicit-b", "explicit-a"]);
    expect(references.overflow).toEqual([]);
  });

  it("keeps target media first in explicit mode and never falls back to upstream media", () => {
    const nodes = [
      node("target", "image", media("target-media")),
      node("explicit", "image", media("explicit-media")),
      node("upstream", "image", media("upstream-media")),
    ];

    const references = collectGenerationReferences(
      "target",
      imageInputModel(3),
      nodes,
      edgesToTarget(["explicit", "upstream"]),
      ["explicit"],
      "explicit",
    );

    expect(references.images.map((reference) => reference.nodeId)).toEqual(["target", "explicit"]);
  });

  it("falls back to connected media when there are no explicit references", () => {
    const nodes = [
      node("target", "video"),
      node("upstream", "image", media("upstream-media")),
    ];

    const references = collectGenerationReferences(
      "target",
      imageInputModel(3),
      nodes,
      edgesToTarget(["upstream"]),
      [],
      "explicit",
    );

    expect(references.images.map((reference) => reference.nodeId)).toEqual(["upstream"]);
    expect(references.overflow).toEqual([]);
  });

  it("deduplicates connected fallback images when explicit mode has no references", () => {
    const shared = media("shared-media");
    const references = collectGenerationReferences(
      "target",
      imageInputModel(3),
      [
        node("target", "video"),
        node("upstream-a", "image", shared),
        node("upstream-b", "image", { ...shared, id: "local-copy", serverId: "shared-media" }),
      ],
      edgesToTarget(["upstream-a", "upstream-b"]),
      [],
      "explicit",
    );

    expect(references.images.map((reference) => reference.nodeId)).toEqual(["upstream-a"]);
    expect(references.overflow).toEqual([]);
  });

  it("keeps target media before connected fallback media when explicit mode has no references", () => {
    const references = collectGenerationReferences(
      "target",
      imageInputModel(2),
      [
        node("target", "image", media("target-media")),
        node("upstream", "image", media("upstream-media")),
      ],
      edgesToTarget(["upstream"]),
      [],
      "explicit",
    );

    expect(references.images.map((reference) => reference.nodeId)).toEqual(["target", "upstream"]);
  });

  it("uses directly connected media until the user chooses explicit references", () => {
    const nodes = [
      node("target", "video"),
      node("upstream-a", "image", media("upstream-a-media")),
      node("upstream-b", "image", media("upstream-b-media")),
    ];

    const references = collectGenerationReferences(
      "target",
      imageInputModel(3),
      nodes,
      [
        { id: "edge-1", source: "upstream-a", target: "target" },
        { id: "edge-2", source: "upstream-b", target: "target" },
      ],
    );

    expect(references.images.map((reference) => reference.nodeId)).toEqual(["upstream-a", "upstream-b"]);
    expect(references.overflow).toEqual([]);
  });

  it("does not treat media beyond the direct incoming node as generation material", () => {
    const nodes = [
      node("target", "video"),
      node("direct", "image", media("direct-media")),
      node("transitive", "image", media("transitive-media")),
    ];
    const edges = [
      { id: "direct-target", source: "direct", target: "target" },
      { id: "transitive-direct", source: "transitive", target: "direct" },
    ];

    const automatic = collectGenerationReferences("target", imageInputModel(3), nodes, edges);
    const explicit = collectGenerationReferences(
      "target",
      imageInputModel(3),
      nodes,
      edges,
      ["transitive", "direct"],
      "explicit",
    );

    expect(automatic.images.map((reference) => reference.nodeId)).toEqual(["direct"]);
    expect(explicit.images.map((reference) => reference.nodeId)).toEqual(["direct"]);
  });

  it("deduplicates explicit and connected nodes that point to the same media", () => {
    const shared = media("shared-media");
    const nodes = [
      node("target", "image", { ...shared, id: "target-copy", serverId: "shared-media" }),
      node("explicit", "image", shared),
      node("upstream", "image", { ...shared, id: "local-copy", serverId: "shared-media" }),
    ];

    const references = collectGenerationReferences(
      "target",
      imageInputModel(4),
      nodes,
      edgesToTarget(["explicit", "upstream"]),
      ["explicit", "upstream", "missing-node"],
    );

    expect(references.images.map((reference) => reference.nodeId)).toEqual(["target"]);
  });

  it("does not treat a video target's own media as generation material", () => {
    const model = referenceMediaModel({
      images: { min: 0, max: 1, multiple: false, role: "frame" },
      videos: { min: 0, max: 1, multiple: false },
    });
    const nodes = [
      node("target", "video", media("target-video")),
      node("upstream", "image", media("upstream-media")),
    ];

    const automatic = collectGenerationReferences("target", model, nodes, edgesToTarget(["upstream"]));
    const explicit = collectGenerationReferences(
      "target",
      model,
      nodes,
      edgesToTarget(["upstream"]),
      ["upstream"],
      "explicit",
    );

    expect(automatic.videos).toEqual([]);
    expect(automatic.images.map((reference) => reference.nodeId)).toEqual(["upstream"]);
    expect(explicit.videos).toEqual([]);
    expect(explicit.images.map((reference) => reference.nodeId)).toEqual(["upstream"]);
  });

  it("does not treat an audio target's own media as generation material", () => {
    const model = referenceMediaModel({
      audios: { min: 0, max: 1, multiple: false },
    });

    const references = collectGenerationReferences(
      "target",
      model,
      [node("target", "audio", media("target-audio"))],
      [],
    );

    expect(references.audios).toEqual([]);
    expect(references.overflow).toEqual([]);
  });

  it("includes a connected video reference only when the model declares video reference capability", () => {
    const model = referenceMediaModel({
      images: { min: 0, max: 1, multiple: false, role: "frame" },
      videos: { min: 0, max: 1, multiple: false },
    });

    const references = collectGenerationReferences(
      "target",
      model,
      [
        node("target", "video", media("target-video")),
        node("reference-video", "video", media("reference-video")),
      ],
      edgesToTarget(["reference-video"]),
    );

    expect(references.videos.map((reference) => reference.nodeId)).toEqual(["reference-video"]);
    expect(references.overflow).toEqual([]);
    expect(generationReferenceError(references, model)).toBeNull();
  });

  it("includes a connected audio reference only when the model declares audio reference capability", () => {
    const model = referenceMediaModel({
      audios: { min: 0, max: 1, multiple: false },
    });

    const references = collectGenerationReferences(
      "target",
      model,
      [
        node("target", "audio", media("target-audio")),
        node("reference-audio", "audio", media("reference-audio")),
      ],
      edgesToTarget(["reference-audio"]),
    );

    expect(references.audios.map((reference) => reference.nodeId)).toEqual(["reference-audio"]);
    expect(references.overflow).toEqual([]);
    expect(generationReferenceError(references, model)).toBeNull();
  });

  it("does not treat an image target without media as its own reference", () => {
    const references = collectGenerationReferences(
      "target",
      imageInputModel(2),
      [
        node("target", "image"),
        node("upstream", "image", media("upstream-media")),
      ],
      edgesToTarget(["upstream"]),
    );

    expect(references.images.map((reference) => reference.nodeId)).toEqual(["upstream"]);
  });

  it("reports references selected for an unsupported media capability", () => {
    const references = collectGenerationReferences(
      "target",
      imageInputModel(0),
      [node("target", "video"), node("explicit", "image", media("image-1"))],
      edgesToTarget(["explicit"]),
      ["explicit"],
    );

    expect(references.images).toEqual([]);
    expect(references.overflow).toEqual([{ kind: "image", selected: 1, max: 0 }]);
  });

  describe("Grok-like video models with image-only reference support", () => {
    const imageOnlyReferenceMedia = {
      images: { min: 0, max: 4, multiple: true },
    } satisfies NonNullable<PublicModel["input"]["referenceMedia"]>;

    it("accepts an image-only reference set without error and keeps the payload limited to images", () => {
      const model = grokLikeVideoModel(imageOnlyReferenceMedia);
      const references = collectGenerationReferences(
        "target",
        model,
        [
          node("target", "video", media("target-video")),
          node("frame-a", "image", media("frame-a-media")),
          node("frame-b", "image", media("frame-b-media")),
        ],
        edgesToTarget(["frame-a", "frame-b"]),
      );

      expect(generationReferenceError(references, model)).toBeNull();
      expect(references.images.map((reference) => reference.nodeId)).toEqual(["frame-a", "frame-b"]);
      expect(references.videos).toEqual([]);
      expect(references.audios).toEqual([]);
      expect(references.overflow).toEqual([]);
      expect(referenceCounts(references)).toEqual({ images: 2, styleImages: 0, elementImages: 0, videos: 0, audios: 0 });
    });

    it("blocks a real video reference with an accurate error and never includes it in the payload", () => {
      const model = grokLikeVideoModel(imageOnlyReferenceMedia);
      const references = collectGenerationReferences(
        "target",
        model,
        [
          node("target", "video", media("target-video")),
          node("frame", "image", media("frame-media")),
          node("reference-video", "video", media("reference-video-media")),
        ],
        edgesToTarget(["frame", "reference-video"]),
      );

      expect(references.videos).toEqual([]);
      expect(references.overflow).toEqual([{ kind: "video", selected: 1, max: 0 }]);
      const error = generationReferenceError(references, model);
      expect(error).toBe("当前模型不支持视频素材输入");
      expect(error).not.toBeNull();
      expect(referenceCounts(references)).toEqual({ images: 1, styleImages: 0, elementImages: 0, videos: 0, audios: 0 });
    });

    it("judges video support from the versioned catalog contract, not the model id", () => {
      const videoCapable = {
        images: { min: 0, max: 1, multiple: false },
        videos: { min: 0, max: 1, multiple: false },
      } satisfies NonNullable<PublicModel["input"]["referenceMedia"]>;
      const nodes = [
        node("target", "video", media("target-video")),
        node("reference-video", "video", media("reference-video-media")),
      ];
      const edges = edgesToTarget(["reference-video"]);

      const genericCapable = collectGenerationReferences("target", grokLikeVideoModel(videoCapable, "generic-video-fixture"), nodes, edges);
      const grokCapable = collectGenerationReferences("target", grokLikeVideoModel(videoCapable, "grok-imagine-video"), nodes, edges);
      expect(genericCapable.videos.map((reference) => reference.nodeId)).toEqual(["reference-video"]);
      expect(grokCapable.videos.map((reference) => reference.nodeId)).toEqual(["reference-video"]);
      expect(generationReferenceError(genericCapable, grokLikeVideoModel(videoCapable))).toBeNull();
      expect(generationReferenceError(grokCapable, grokLikeVideoModel(videoCapable))).toBeNull();

      const imageOnlyGeneric = collectGenerationReferences("target", grokLikeVideoModel(imageOnlyReferenceMedia, "generic-video-fixture"), nodes, edges);
      const imageOnlyGrok = collectGenerationReferences("target", grokLikeVideoModel(imageOnlyReferenceMedia, "grok-imagine-video"), nodes, edges);
      expect(generationReferenceError(imageOnlyGeneric, grokLikeVideoModel(imageOnlyReferenceMedia))).toBe("当前模型不支持视频素材输入");
      expect(generationReferenceError(imageOnlyGrok, grokLikeVideoModel(imageOnlyReferenceMedia))).toBe("当前模型不支持视频素材输入");
    });
  });

  it("keeps over-cap references visible and reports the model limit", () => {
    const references = collectGenerationReferences(
      "target",
      imageInputModel(2),
      [
        node("target", "video"),
        node("explicit-a", "image", media("image-a")),
        node("explicit-b", "image", media("image-b")),
        node("explicit-c", "image", media("image-c")),
      ],
      edgesToTarget(["explicit-a", "explicit-b", "explicit-c"]),
      ["explicit-a", "explicit-b", "explicit-c"],
      "explicit",
    );

    expect(references.images.map((reference) => reference.nodeId)).toEqual(["explicit-a", "explicit-b", "explicit-c"]);
    expect(references.overflow).toEqual([{ kind: "image", selected: 3, max: 2 }]);
  });

  it("reports the request limit without silently discarding references", () => {
    const explicitIds = Array.from({ length: 32 }, (_, index) => `explicit-${index}`);
    const references = collectGenerationReferences(
      "target",
      imageInputModel(64),
      [node("target", "image", media("target-media")), ...explicitIds.map((id) => node(id, "image", media(`${id}-media`)))],
      edgesToTarget(explicitIds),
      explicitIds,
      "explicit",
    );

    expect(references.images).toHaveLength(33);
    expect(references.overflow).toEqual([{ kind: "image", selected: 33, max: 32 }]);
  });

  it("ignores stale explicit ids that are no longer upstream", () => {
    const references = collectGenerationReferences(
      "target",
      imageInputModel(2),
      [node("target", "video"), node("disconnected", "image", media("disconnected-media"))],
      [],
      ["disconnected"],
      "explicit",
    );

    expect(references.images).toEqual([]);
    expect(references.overflow).toEqual([]);
  });

  it("auto-assigns a single catalog-declared image purpose", () => {
    const references = collectGenerationReferences(
      "target",
      referenceMediaModel({ styleImages: { min: 0, max: 4, multiple: true } }),
      [node("target", "video"), node("style", "image", media("style-media"))],
      edgesToTarget(["style"]),
    );

    expect(references.imagePurposes).toEqual(["styleImages"]);
    expect(references.styleImages.map((reference) => reference.nodeId)).toEqual(["style"]);
    expect(references.images).toEqual([]);
    expect(references.unassignedImages).toEqual([]);
    expect(referenceCounts(references)).toEqual({ images: 0, styleImages: 1, elementImages: 0, videos: 0, audios: 0 });
  });

  it("requires a purpose for every image when the catalog exposes multiple slots", () => {
    const shared = { ...media("local-style"), serverId: "server-style" };
    const model = referenceMediaModel({
      images: { min: 0, max: 1, multiple: false, role: "frame" },
      styleImages: { min: 0, max: 4, multiple: true },
      elementImages: { min: 0, max: 3, multiple: true },
    });
    const nodes = [
      node("target", "video"),
      node("frame", "image", media("frame-media")),
      node("style", "image", shared),
      node("element", "image", media("element-media")),
    ];
    const edges = edgesToTarget(["frame", "style", "element"]);

    const unassigned = collectGenerationReferences("target", model, nodes, edges);
    expect(unassigned.unassignedImages.map((reference) => reference.nodeId)).toEqual(["frame", "style", "element"]);
    expect(generationReferenceError(unassigned, model)).toBe("请为 3 张参考图片选择用途");

    const assigned = collectGenerationReferences(
      "target",
      model,
      nodes,
      edges,
      [],
      "auto",
      { "frame-media": "images", "server-style": "styleImages", "element-media": "elementImages" },
    );
    expect(assigned.images.map((reference) => reference.nodeId)).toEqual(["frame"]);
    expect(assigned.styleImages.map((reference) => reference.nodeId)).toEqual(["style"]);
    expect(assigned.elementImages.map((reference) => reference.nodeId)).toEqual(["element"]);
    expect(assigned.unassignedImages).toEqual([]);
    expect(generationReferenceError(assigned, model)).toBeNull();
  });

  it("treats omitted multiple as a single-item slot and excludes max zero purposes", () => {
    const model = referenceMediaModel({
      styleImages: { min: 0, max: 4 } as never,
      elementImages: { min: 0, max: 0, multiple: true },
    });
    const references = collectGenerationReferences(
      "target",
      model,
      [
        node("target", "video"),
        node("style-a", "image", media("style-a-media")),
        node("style-b", "image", media("style-b-media")),
      ],
      edgesToTarget(["style-a", "style-b"]),
    );

    expect(references.imagePurposes).toEqual(["styleImages"]);
    expect(references.styleImages).toHaveLength(2);
    expect(references.overflow).toEqual([{ kind: "image", purpose: "styleImages", selected: 2, max: 1 }]);
  });

  it("reports the aggregate reference limit without discarding selected material", () => {
    const model = referenceMediaModel({
      images: { min: 0, max: 4, multiple: true },
      styleImages: { min: 0, max: 4, multiple: true },
      maxTotalItems: 2,
    });
    const references = collectGenerationReferences(
      "target",
      model,
      [
        node("target", "video"),
        node("frame", "image", media("frame-media")),
        node("style-a", "image", media("style-a-media")),
        node("style-b", "image", media("style-b-media")),
      ],
      edgesToTarget(["frame", "style-a", "style-b"]),
      [],
      "auto",
      { "frame-media": "images", "style-a-media": "styleImages", "style-b-media": "styleImages" },
    );

    expect(references.images).toHaveLength(1);
    expect(references.styleImages).toHaveLength(2);
    expect(references.aggregateOverflow).toEqual({ selected: 3, max: 2 });
    expect(generationReferenceError(references, model)).toContain("合计最多支持 2 个");
  });

  it("uses the ten-item request limit for video references", () => {
    const model = referenceMediaModel({ videos: { min: 0, max: 10, multiple: true } });
    const videoNodes = Array.from({ length: 11 }, (_, index) => node(`video-${index}`, "video", media(`video-media-${index}`)));
    const references = collectGenerationReferences(
      "target",
      model,
      [node("target", "image"), ...videoNodes],
      edgesToTarget(videoNodes.map((item) => item.id)),
    );

    expect(references.videos).toHaveLength(11);
    expect(references.overflow).toEqual([{ kind: "video", selected: 11, max: 10 }]);
    expect(generationReferenceError(references, model)).toContain("最多支持 10 个");
  });

  it("keeps reference semantics readable without putting media URLs in the prompt", () => {
    const references = collectGenerationReferences(
      "target",
      imageInputModel(2),
      [node("target", "video"), node("image-a", "image", media("media-a")), node("image-b", "image", media("media-b"))],
      edgesToTarget(["image-a", "image-b"]),
    );

    const prompt = composeReferenceAwarePrompt("让图片1缓慢转身", references);
    expect(prompt).toBe("让图片1缓慢转身\n参考素材按上传顺序：图片1、图片2");
    expect(prompt).not.toMatch(/(?:blob:|data:|https?:\/\/|media-a|media-b)/);
  });

  describe("reference video durations (H3 参考视频必须成对声明时长)", () => {
    // 上游目录：minimax_h3 的 referenceVideoDurations 是 required_with
    // referenceVideos 的参数，缺时长整单 400（线上表现为「请求参数无效」），
    // 且参考视频合计不超过 15 秒。
    const h3LikeVideoModel = (videos: { min: number; max: number; multiple: boolean }) => ({
      ...grokLikeVideoModel({ images: { min: 0, max: 9, multiple: true }, videos }),
      parameters: [
        { name: "prompt", label: "提示词", type: "string", required: true },
        { name: "referenceVideoDurations", label: "参考视频时长（秒）", type: "array", maxItems: 3 },
      ],
    } as PublicModel);

    const videoReferenceNodes = (durations: Array<number | null>) => [
      node("target", "video", media("target-video")),
      ...durations.map((durationMs, index) => node(
        `reference-video-${index}`,
        "video",
        { ...media(`reference-video-media-${index}`), durationMs },
      )),
    ];

    it("returns the aligned duration array for a model that declares the parameter", () => {
      const model = h3LikeVideoModel({ min: 0, max: 3, multiple: true });
      const references = collectGenerationReferences(
        "target",
        model,
        videoReferenceNodes([6_500, 2_000]),
        edgesToTarget(["reference-video-0", "reference-video-1"]),
      );

      expect(referenceVideoDurations(references)).toEqual([6.5, 2]);
      expect(generationReferenceError(references, model)).toBeNull();
    });

    it("keeps a reference video without a probed duration submittable", () => {
      // 画布上新生成的视频工件不带时长（服务端播放后回写且不回流本地节点），
      // 前端不再硬拦：面板会按需探测补时长，也不拦截提交，服务端从素材记录与
      // 任务工件兜底推导。
      const model = h3LikeVideoModel({ min: 0, max: 3, multiple: true });
      const references = collectGenerationReferences(
        "target",
        model,
        videoReferenceNodes([1_000, null]),
        edgesToTarget(["reference-video-0", "reference-video-1"]),
      );

      expect(referenceVideoDurations(references)).toBeNull();
      expect(generationReferenceError(references, model)).toBeNull();
    });

    it("blocks reference videos whose total duration exceeds the catalog cap", () => {
      const model = h3LikeVideoModel({ min: 0, max: 3, multiple: true });
      const references = collectGenerationReferences(
        "target",
        model,
        videoReferenceNodes([10_000, 6_000]),
        edgesToTarget(["reference-video-0", "reference-video-1"]),
      );

      expect(generationReferenceError(references, model)).toBe("参考视频总时长不能超过 15 秒");
    });

    it("ignores the duration contract for models that do not declare it", () => {
      const references = collectGenerationReferences(
        "target",
        referenceMediaModel({ videos: { min: 0, max: 3, multiple: true } }),
        videoReferenceNodes([1_000, null]),
        edgesToTarget(["reference-video-0", "reference-video-1"]),
      );

      expect(generationReferenceError(references, referenceMediaModel({ videos: { min: 0, max: 3, multiple: true } }))).toBeNull();
    });
  });
});

describe("collectUpstreamTextContent", () => {
  it("collects only direct-incoming text in edge order, ignores blanks, and deduplicates bodies", () => {
    const bodies = collectUpstreamTextContent(
      "target",
      [
        node("target", "image"),
        node("direct", "text", null, "  rainy street  "),
        node("duplicate", "text", null, "rainy street"),
        node("blank", "text", null, " \n\t "),
        node("bridge", "video"),
        node("transitive", "text", null, "warm practical light"),
      ],
      [
        { id: "direct-target", source: "direct", target: "target" },
        { id: "duplicate-target", source: "duplicate", target: "target" },
        { id: "blank-target", source: "blank", target: "target" },
        { id: "bridge-target", source: "bridge", target: "target" },
        { id: "transitive-bridge", source: "transitive", target: "bridge" },
        { id: "cycle", source: "target", target: "bridge" },
      ],
    );

    // 只收 target 直接入边上的文字；隔着 bridge 的 transitive 不再参与。
    expect(bodies).toEqual(["rainy street"]);
  });

  it("never lets text two hops away reach the target through a media bridge", () => {
    const bodies = collectUpstreamTextContent(
      "target",
      [
        node("target", "image"),
        node("photo", "image", media("photo-media")),
        node("distant-text", "text", null, "遥远的说明文字"),
        node("direct-text", "text", null, "直连说明"),
      ],
      [
        { id: "photo-target", source: "photo", target: "target" },
        { id: "distant-photo", source: "distant-text", target: "photo" },
        { id: "direct-target", source: "direct-text", target: "target" },
      ],
    );

    expect(bodies).toEqual(["直连说明"]);
  });

  it("returns nothing when no text node is directly connected", () => {
    const bodies = collectUpstreamTextContent(
      "target",
      [
        node("target", "video"),
        node("photo", "image", media("photo-media")),
        node("far-text", "text", null, "两跳外的文字"),
      ],
      [
        { id: "photo-target", source: "photo", target: "target" },
        { id: "far-photo", source: "far-text", target: "photo" },
      ],
    );

    expect(bodies).toEqual([]);
  });
});

function imageInputModel(max: number) {
  return {
    input: {
      textRequired: false,
      ...(max ? { images: { multiple: max > 1, max } } : {}),
    },
  } as PublicModel;
}

function edgesToTarget(sourceIds: readonly string[]) {
  return sourceIds.map((source, index) => ({ id: `edge-${index}`, source, target: "target" }));
}

function media(id: string): CanvasMedia {
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    size: 128,
    source: "server",
    serverId: null,
    width: 1,
    height: 1,
    durationMs: null,
  };
}

function node(
  id: string,
  kind: "text" | "image" | "video" | "audio",
  nodeMedia: CanvasMedia | null = null,
  body = "",
): KachangNode {
  return {
    id,
    type: "kachang",
    position: { x: 0, y: 0 },
    data: {
      kind,
      body,
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

function referenceMediaModel(referenceMedia: NonNullable<PublicModel["input"]["referenceMedia"]>) {
  return {
    input: {
      textRequired: false,
      referenceMedia,
    },
  } as PublicModel;
}

function grokLikeVideoModel(
  referenceMedia: NonNullable<PublicModel["input"]["referenceMedia"]>,
  id = "grok-video-fixture",
) {
  return {
    id,
    modality: "video",
    input: {
      textRequired: true,
      referenceMedia,
    },
  } as PublicModel;
}
