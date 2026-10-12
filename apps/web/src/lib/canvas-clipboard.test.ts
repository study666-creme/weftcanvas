import { describe, expect, it } from "vitest";

import { createCanvasEdge, createCanvasNode } from "./node-factory";
import { parseCanvasClipboard, serializeCanvasClipboard } from "./canvas-clipboard";

describe("canvas clipboard", () => {
  it("round-trips a bounded node graph and preserves internal edges", () => {
    const text = createCanvasNode("text", { x: 20, y: 30 }, { body: "镜头描述" });
    const image = createCanvasNode("image", { x: 420, y: 30 });
    const edge = createCanvasEdge(text.id, image.id);
    const parsed = parseCanvasClipboard(
      serializeCanvasClipboard({ nodes: [text, image], edges: [edge], groups: [] }),
    );

    expect(parsed?.nodes.map((node) => node.id)).toEqual([text.id, image.id]);
    expect(parsed?.edges).toHaveLength(1);
    expect(parsed?.edges[0]).toMatchObject({
      source: text.id,
      target: image.id,
      type: "weftcanvas",
    });
  });

  it("rejects malformed and oversized clipboard payloads", () => {
    expect(parseCanvasClipboard("not-json")).toBeNull();
    expect(parseCanvasClipboard(JSON.stringify({ kind: "other", version: 1 }))).toBeNull();
    expect(parseCanvasClipboard("x".repeat(2_000_001))).toBeNull();
  });
});
