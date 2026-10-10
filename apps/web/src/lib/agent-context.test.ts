import { describe, expect, it } from "vitest";

import { createCanvasNode } from "./node-factory";
import { createAgentCanvasContext } from "./agent-context";

describe("agent canvas context", () => {
  it("prioritizes selected nodes and excludes media identifiers", () => {
    const nodes = Array.from({ length: 121 }, (_, index) => createCanvasNode("text", { x: index * 10, y: 0 }, {
      body: `节点 ${index}`,
    }));
    for (const node of nodes) node.selected = false;
    const selected = nodes[120]!;
    selected.selected = true;
    selected.data = {
      ...selected.data,
      kind: "image",
      media: {
        id: "private-local-id",
        serverId: "private-server-id",
        source: "server",
        name: "private-name.png",
        mimeType: "image/png",
        size: 128,
        width: 1280,
        height: 720,
        durationMs: null,
      },
    };

    const context = createAgentCanvasContext({
      projectId: "project-1",
      projectName: "测试画布",
      nodes,
      edges: [],
      groups: [],
      directorStage: {
        open: true,
        shots: [{
          shotId: "shot-01",
          title: "建立空间",
          entities: [{ id: "actor-a", kind: "actor", label: "角色 A", x: 0, y: 0, z: 1, rotationY: 0, scale: 1 }],
        }],
      },
    });

    expect(context.nodes).toHaveLength(120);
    expect(context.nodes[0]).toMatchObject({ id: selected.id, selected: true, media: { width: 1280, height: 720 } });
    expect(context.omittedNodeCount).toBe(1);
    expect(JSON.stringify(context)).not.toContain("private-local-id");
    expect(JSON.stringify(context)).not.toContain("private-server-id");
    expect(JSON.stringify(context)).not.toContain("private-name.png");
    expect(context.directorStage?.shots[0]).toMatchObject({ shotId: "shot-01", entities: [{ id: "actor-a" }] });
  });

  it("keeps the context revision stable across array order and changes it after an edit", () => {
    const first = createCanvasNode("text", { x: 10, y: 20 }, { body: "开场" });
    const second = createCanvasNode("text", { x: 320, y: 20 }, { body: "转折" });
    const source = {
      projectId: "project-1",
      projectName: "测试画布",
      nodes: [first, second],
      edges: [],
      groups: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const initial = createAgentCanvasContext(source);
    const reordered = createAgentCanvasContext({ ...source, nodes: [second, first] });
    expect(reordered.contextRevision).toBe(initial.contextRevision);

    const edited = structuredClone(first);
    edited.data.body = "新的开场";
    const changed = createAgentCanvasContext({ ...source, nodes: [edited, second] });
    expect(changed.contextRevision).not.toBe(initial.contextRevision);

    const legacyGuidance = createAgentCanvasContext({
      ...source,
      creativeGuidance: {
        mode: "baseline",
        baseline: { aspectRatio: "16:9", visualStyle: "电影写实", targetDuration: "60 秒", locked: true },
      },
    });
    expect(legacyGuidance.contextRevision).not.toBe(initial.contextRevision);
    expect(legacyGuidance.creativeGuidance).toMatchObject({ mode: "professional", baseline: { locked: true } });

    const professionalGuidance = createAgentCanvasContext({
      ...source,
      creativeGuidance: {
        mode: "professional",
        baseline: { aspectRatio: "16:9", visualStyle: "电影写实", targetDuration: "60 秒", locked: true },
      },
    });
    expect(professionalGuidance.contextRevision).toBe(legacyGuidance.contextRevision);
  });
});
