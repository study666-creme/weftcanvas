import type { CanvasGroup } from "@kachang/contracts";
import { describe, expect, it } from "vitest";

import type { KachangNode } from "../types";
import { arrangeGroupNodes, getGroupBounds, indexCanvasNodes, normalizeGroups } from "./node-groups";

function node(id: string, x: number, y: number, width = 100, height = 80): KachangNode {
  return {
    id,
    type: "kachang",
    position: { x, y },
    width,
    height,
    data: {
      kind: "text",
      body: "",
      accent: "jade",
      status: "idle",
      progress: null,
      media: null,
      directorCapture: null,
      config: null,
      edit: null,
      music: null,
      generation: { modelId: null, parameters: {}, referenceImagePurposes: {}, maxOutputTokens: null, referenceMode: "auto", referenceNodeIds: [], jobId: null, jobVersion: null, jobCreatedAt: null, jobStatus: null, error: null },
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

const group: CanvasGroup = {
  id: "group-1",
  name: "组 1",
  color: "#9ca3a0",
  nodeIds: ["a", "b", "c"],
  frame: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("node group geometry", () => {
  it("builds a padded frame and removes groups with fewer than two live members", () => {
    const nodes = [node("a", 20, 30), node("b", 220, 150)];
    expect(getGroupBounds(group, nodes)).toEqual({ x: 0, y: -24, width: 340, height: 274 });
    expect(getGroupBounds(group, nodes, indexCanvasNodes(nodes))).toEqual({ x: 0, y: -24, width: 340, height: 274 });
    expect(normalizeGroups([group], [nodes[0]!])).toEqual([]);
  });

  it("arranges members without changing unrelated nodes", () => {
    const nodes = [node("a", 0, 0), node("b", 300, 180), node("c", 720, 10), node("outside", 900, 900)];
    const arranged = arrangeGroupNodes(nodes, group);
    expect(arranged.find((item) => item.id === "outside")?.position).toEqual({ x: 900, y: 900 });
    expect(new Set(arranged.filter((item) => group.nodeIds.includes(item.id)).map((item) => `${item.position.x}:${item.position.y}`)).size).toBe(3);
  });
});
