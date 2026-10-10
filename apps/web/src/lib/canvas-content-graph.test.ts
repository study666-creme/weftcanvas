import { describe, expect, it } from "vitest";

import { createCanvasEdge, createCanvasNode } from "./node-factory";
import { selectCanvasContentGraph } from "./canvas-content-graph";

describe("canvas content graph selector", () => {
  it("keeps a stable projection for layout-only and selection changes", () => {
    const source = createCanvasNode("text", { x: 0, y: 0 }, { body: "source" });
    const target = createCanvasNode("image", { x: 320, y: 0 });
    const edge = createCanvasEdge(source.id, target.id);
    const selected = selectCanvasContentGraph({ nodes: [source, target], edges: [edge] });

    const layoutOnly = selectCanvasContentGraph({
      nodes: [
        { ...source, position: { x: 48, y: 24 }, selected: true, dragging: true },
        target,
      ],
      edges: [{ ...edge, selected: true }],
    });

    expect(layoutOnly).toBe(selected);
  });

  it("changes the projection when node content or edge topology changes", () => {
    const source = createCanvasNode("text", { x: 0, y: 0 }, { body: "source" });
    const target = createCanvasNode("image", { x: 320, y: 0 });
    const selected = selectCanvasContentGraph({ nodes: [source, target], edges: [] });

    const contentChanged = selectCanvasContentGraph({
      nodes: [{ ...source, data: { ...source.data, body: "updated" } }, target],
      edges: [],
    });
    const topologyChanged = selectCanvasContentGraph({
      nodes: contentChanged.nodes,
      edges: [createCanvasEdge(source.id, target.id)],
    });

    expect(contentChanged).not.toBe(selected);
    expect(topologyChanged).not.toBe(contentChanged);
  });

  it("compares one layout-only store publication only once across subscribers", () => {
    const source = createCanvasNode("text", { x: 0, y: 0 }, { body: "source" });
    const target = createCanvasNode("image", { x: 320, y: 0 });
    const edge = createCanvasEdge(source.id, target.id);
    const selected = selectCanvasContentGraph({ nodes: [source, target], edges: [edge] });
    let reads = 0;
    const countReads = <Value extends object>(value: Value) => new Proxy(value, {
      get(targetValue, property, receiver) {
        reads += 1;
        return Reflect.get(targetValue, property, receiver);
      },
    });
    const nodes = countReads([
      { ...source, position: { x: 48, y: 24 }, selected: true, dragging: true },
      target,
    ]);
    const edges = countReads([{ ...edge, selected: true }]);

    const firstSubscriber = selectCanvasContentGraph({ nodes, edges });
    const readsAfterFirstSubscriber = reads;
    const secondSubscriber = selectCanvasContentGraph({ nodes, edges });

    expect(firstSubscriber).toBe(selected);
    expect(secondSubscriber).toBe(firstSubscriber);
    expect(readsAfterFirstSubscriber).toBeGreaterThan(0);
    expect(reads).toBe(readsAfterFirstSubscriber);
  });
});
