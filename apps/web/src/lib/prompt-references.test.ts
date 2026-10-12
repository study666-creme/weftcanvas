import { describe, expect, it } from "vitest";

import { createCanvasNode } from "./node-factory";
import {
  createReferenceMentionMap,
  deletePromptReferenceAtSelection,
  ensurePromptReferenceMentions,
  findPromptReferenceRanges,
  generationReferenceMentionNodeIds,
  pruneDisconnectedPromptReferences,
  reconcileReferenceMentions,
  referenceIdsPresentInBody,
  stripReferenceMentionTokens,
  stripUnboundReferenceMentions,
} from "./prompt-references";

describe("prompt references", () => {
  const nodes = [
    referenceNode("image-a", "image"),
    referenceNode("video-a", "video"),
    referenceNode("image-b", "image"),
  ];

  it("numbers each media kind in stable request order", () => {
    expect([...createReferenceMentionMap(["image-b", "video-a", "image-a"], nodes)]).toEqual([
      ["image-b", "图片1"],
      ["video-a", "视频1"],
      ["image-a", "图片2"],
    ]);
  });

  it("removes one identity and renumbers surviving mentions without losing punctuation", () => {
    expect(
      reconcileReferenceMentions(
        "参考 @图片1，结合 @视频1 和 @图片2。",
        ["image-b", "video-a", "image-a"],
        ["video-a", "image-a"],
        nodes,
      ),
    ).toBe("参考，结合 @视频1 和 @图片1。");
  });

  it("derives explicit identities from visible mentions and strips stale tokens", () => {
    expect(
      referenceIdsPresentInBody("只用 @图片2，再用一次 @图片2", ["image-a", "image-b"], nodes),
    ).toEqual(["image-b"]);
    expect(stripUnboundReferenceMentions("保留 @图片1，删除 @图片2。", ["image-a"], nodes)).toBe(
      "保留 @图片1，删除。",
    );
  });

  it("finds complete mention ranges for atomic keyboard deletion", () => {
    expect(findPromptReferenceRanges("A @图片1 B @视频1", ["image-a", "video-a"], nodes)).toEqual([
      { nodeId: "image-a", start: 2, end: 6 },
      { nodeId: "video-a", start: 9, end: 13 },
    ]);
  });

  it("restores legacy text labels and prepends references that had no stored position", () => {
    expect(
      ensurePromptReferenceMentions(
        "参考图片1",
        ["image-a", "video-a"],
        ["image-a", "video-a"],
        nodes,
      ),
    ).toBe("@视频1 参考@图片1");
  });

  it.each([
    ["backward" as const, 6, "A B", 2],
    ["forward" as const, 2, "A B", 2],
  ])(
    "deletes a complete reference token %s from an adjacent caret",
    (direction, caret, body, nextCaret) => {
      expect(
        deletePromptReferenceAtSelection("A @图片1 B", caret, caret, ["image-a"], nodes, direction),
      ).toEqual({ body, caret: nextCaret, affectedNodeIds: ["image-a"] });
    },
  );

  it("deletes the trailing separator with a token in one Backspace", () => {
    expect(
      deletePromptReferenceAtSelection("描述 @图片1 ", 8, 8, ["image-a"], nodes, "backward"),
    ).toEqual({ body: "描述", caret: 2, affectedNodeIds: ["image-a"] });
  });

  it("does not intercept deletion in ordinary prompt text", () => {
    expect(
      deletePromptReferenceAtSelection("A @图片1 B", 1, 1, ["image-a"], nodes, "backward"),
    ).toBeNull();
  });

  it("keeps a reference identity while another token for it remains", () => {
    const deletion = deletePromptReferenceAtSelection(
      "@图片1 与 @图片1",
      4,
      4,
      ["image-a"],
      nodes,
      "backward",
    );
    expect(deletion?.body).toBe("与 @图片1");
    expect(referenceIdsPresentInBody(deletion?.body ?? "", ["image-a"], nodes)).toEqual([
      "image-a",
    ]);
  });

  it("unwraps bound mention text so upstream keeps readable reference semantics", () => {
    expect(
      stripReferenceMentionTokens("参考 @图片1，结合 @视频1。", ["image-a", "video-a"], nodes),
    ).toBe("参考 图片1，结合 视频1。");
  });

  it("offsets connected reference labels when target media is uploaded first", () => {
    const target = referenceNode("target", "image");
    const mentionIds = generationReferenceMentionNodeIds(
      "target",
      ["image-a", "image-b"],
      [target, ...nodes],
    );
    expect([...createReferenceMentionMap(mentionIds, [target, ...nodes])]).toEqual([
      ["target", "图片1"],
      ["image-a", "图片2"],
      ["image-b", "图片3"],
    ]);
  });

  it("cleans explicit references and body labels after a connection is removed", () => {
    const target = createCanvasNode(
      "video",
      { x: 0, y: 0 },
      {
        body: "使用 @图片1 和 @图片2",
        generation: {
          ...createCanvasNode("video", { x: 0, y: 0 }).data.generation,
          referenceMode: "explicit",
          referenceNodeIds: ["image-a", "image-b"],
        },
      },
    );
    target.id = "target";
    const result = pruneDisconnectedPromptReferences(
      [target, ...nodes],
      [{ id: "edge-a", source: "image-a", target: "target" }],
    );
    expect(result[0]?.data.body).toBe("使用 @图片1 和");
    expect(result[0]?.data.generation.referenceNodeIds).toEqual(["image-a"]);
    expect(result[0]?.data.generation.referenceMode).toBe("explicit");
  });

  it("drops an explicit reference that is only transitively upstream", () => {
    const target = createCanvasNode(
      "video",
      { x: 0, y: 0 },
      {
        body: "使用 @图片1",
        generation: {
          ...createCanvasNode("video", { x: 0, y: 0 }).data.generation,
          referenceMode: "explicit",
          referenceNodeIds: ["image-a"],
        },
      },
    );
    target.id = "target";
    const bridge = referenceNode("bridge", "video");

    const result = pruneDisconnectedPromptReferences(
      [target, bridge, ...nodes],
      [
        { id: "image-bridge", source: "image-a", target: "bridge" },
        { id: "bridge-target", source: "bridge", target: "target" },
      ],
    );

    expect(result[0]?.data.body).toBe("使用");
    expect(result[0]?.data.generation.referenceNodeIds).toEqual([]);
  });
});

function referenceNode(id: string, kind: "image" | "video") {
  const node = createCanvasNode(
    kind,
    { x: 0, y: 0 },
    {
      media: {
        id: `${id}-media`,
        name: id,
        mimeType: kind === "image" ? "image/png" : "video/mp4",
        size: 1,
        source: "server",
        serverId: null,
        width: 1,
        height: 1,
        durationMs: kind === "video" ? 1 : null,
      },
    },
  );
  node.id = id;
  return node;
}
