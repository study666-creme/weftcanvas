import { describe, expect, it } from "vitest";

import { CANVAS_SCHEMA_VERSION, canvasProjectSchema } from "./canvas";

describe("canvasProjectSchema", () => {
  it("accepts the minimum project contract", () => {
    const now = Date.now();
    const project = canvasProjectSchema.parse({
      schemaVersion: CANVAS_SCHEMA_VERSION,
      id: "project-1",
      name: "纬线画布",
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: now,
      updatedAt: now,
    });

    expect(project.schemaVersion).toBe(1);
    expect(project.groups).toEqual([]);
  });

  it("upgrades older local nodes with generation and media defaults", () => {
    const now = Date.now();
    const project = canvasProjectSchema.parse({
      schemaVersion: CANVAS_SCHEMA_VERSION,
      id: "project-legacy",
      name: "旧项目",
      nodes: [
        {
          id: "node-1",
          type: "weftcanvas",
          position: { x: 10, y: 20 },
          data: {
            kind: "image",
            body: "参考画面",
            media: { id: "local-media", name: "frame.png", mimeType: "image/png", size: 128 },
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: now,
      updatedAt: now,
    });

    expect(project.nodes[0]?.data.media).toMatchObject({ source: "local", serverId: null });
    expect(project.nodes[0]?.data.generation).toEqual({
      modelId: null,
      parameters: {},
      referenceImagePurposes: {},
      referenceMode: "auto",
      referenceNodeIds: [],
      maxOutputTokens: null,
      jobId: null,
      jobVersion: null,
      jobCreatedAt: null,
      jobStatus: null,
      error: null,
    });
    expect(project.nodes[0]?.data.progress).toBeNull();
  });

  it("keeps legacy groups compatible with resizable empty frames", () => {
    const now = Date.now();
    const project = canvasProjectSchema.parse({
      schemaVersion: CANVAS_SCHEMA_VERSION,
      id: "project-groups",
      name: "Groups",
      nodes: [],
      edges: [],
      groups: [
        {
          id: "group-1",
          name: "Group 1",
          color: "#999",
          nodeIds: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: now,
      updatedAt: now,
    });
    expect(project.groups[0]).toMatchObject({ nodeIds: [], frame: null });
  });

  it("parses edit nodes with a persisted clip composition and legacy projects without it", () => {
    const now = Date.now();
    const project = canvasProjectSchema.parse({
      schemaVersion: CANVAS_SCHEMA_VERSION,
      id: "project-edit",
      name: "剪辑",
      nodes: [
        {
          id: "edit-node",
          type: "weftcanvas",
          position: { x: 0, y: 0 },
          data: {
            kind: "edit",
            body: "",
            media: null,
            createdAt: now,
            updatedAt: now,
            edit: {
              clips: [
                {
                  id: "clip-1",
                  track: "video",
                  nodeId: "source-node",
                  mediaId: "media-1",
                  name: "素材.mp4",
                  kind: "video",
                  sourceDurationMs: 5000,
                  inMs: 500,
                  outMs: 4000,
                },
              ],
            },
          },
        },
        {
          id: "legacy-node",
          type: "weftcanvas",
          position: { x: 200, y: 0 },
          data: { kind: "image", body: "", createdAt: now, updatedAt: now },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: now,
      updatedAt: now,
    });

    const editNode = project.nodes.find((node) => node.id === "edit-node");
    expect(editNode?.data.kind).toBe("edit");
    expect(editNode?.data.edit).toMatchObject({
      clips: [{ id: "clip-1", track: "video", inMs: 500, outMs: 4000 }],
    });
    expect(project.nodes.find((node) => node.id === "legacy-node")?.data.edit).toBeNull();
  });
});
