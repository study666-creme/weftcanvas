import { describe, expect, it } from "vitest";

import {
  canvasImportPreviewResponseSchema,
  canvasImportRequestSchema,
  canvasImportProvidersResponseSchema,
} from "./canvas-import.js";
import { canvasProjectSchema } from "./canvas.js";

describe("第三方画布导入契约", () => {
  it("请求只带来源与用户粘贴的原始标识", () => {
    expect(canvasImportRequestSchema.parse({ provider: "libtv", reference: "  abc  " })).toEqual({
      provider: "libtv",
      reference: "abc",
    });
    expect(
      canvasImportRequestSchema.safeParse({ provider: "unknown", reference: "x" }).success,
    ).toBe(false);
    expect(canvasImportRequestSchema.safeParse({ provider: "tapnow", reference: "" }).success).toBe(
      false,
    );
  });

  it("预览补齐可选字段的默认值，并拒绝空标识与越界数量", () => {
    const parsed = canvasImportPreviewResponseSchema.parse({
      ok: true,
      data: {
        provider: "updream",
        sourceId: "abc123",
        projectName: "画布",
        batchId: "updream-1-abcdefgh",
        nodes: [
          {
            key: "7",
            kind: "text",
            position: { x: 0, y: 0 },
            width: 300,
            height: 180,
          },
        ],
        edges: [],
      },
    });
    expect(parsed.data.nodes[0]).toMatchObject({
      title: "",
      body: "",
      prompt: "",
      status: "idle",
      error: "",
      sourceType: "",
      asset: null,
    });
    expect(parsed.data.skipped).toEqual([]);
    expect(parsed.data.warnings).toEqual([]);
    expect(
      canvasImportPreviewResponseSchema.safeParse({
        ok: true,
        data: {
          provider: "updream",
          sourceId: "",
          projectName: "",
          batchId: "b",
          nodes: [],
          edges: [],
        },
      }).success,
    ).toBe(false);
  });

  it("素材路径必填，尺寸可空", () => {
    const parsed = canvasImportPreviewResponseSchema.parse({
      ok: true,
      data: {
        provider: "tapnow",
        sourceId: "Share-1",
        projectName: "",
        batchId: "b",
        nodes: [
          {
            key: "n1",
            kind: "image",
            position: { x: 1, y: 2 },
            width: 360,
            height: 360,
            asset: { path: "/api/v1/canvas-import/asset?p=tapnow&u=x", mimeType: "image/png" },
          },
        ],
        edges: [{ key: "e1", source: "n1", target: "n1" }],
      },
    });
    expect(parsed.data.nodes[0]?.asset).toEqual({
      path: "/api/v1/canvas-import/asset?p=tapnow&u=x",
      mimeType: "image/png",
      width: null,
      height: null,
      durationMs: null,
    });
  });

  it("来源可用性列出三个来源", () => {
    const parsed = canvasImportProvidersResponseSchema.parse({
      ok: true,
      data: {
        providers: [
          { provider: "libtv", available: false, reason: "未配置令牌" },
          { provider: "tapnow", available: true },
          { provider: "updream", available: true },
        ],
      },
    });
    expect(parsed.data.providers[1]).toEqual({
      provider: "tapnow",
      available: true,
      reason: "",
    });
  });
});

describe("节点导入来源字段", () => {
  const project = {
    schemaVersion: 1 as const,
    id: "p1",
    name: "项目",
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: 0,
    updatedAt: 0,
  };

  it("导入节点带上来源身份，普通节点没有这一段", () => {
    const parsed = canvasProjectSchema.parse({
      ...project,
      nodes: [
        {
          id: "n1",
          type: "weftcanvas",
          position: { x: 0, y: 0 },
          data: {
            kind: "image",
            createdAt: 0,
            updatedAt: 0,
            importedFrom: {
              provider: "libtv",
              sourceId: "0123456789abcdef0123456789abcdef",
              sourceName: "分镜画布",
              nodeKey: "n1",
              batchId: "libtv-1-abcdefgh",
              sourceType: "material-style",
              importedAt: 1_700_000_000_000,
            },
          },
        },
        {
          id: "n2",
          type: "weftcanvas",
          position: { x: 400, y: 0 },
          data: { kind: "text", createdAt: 0, updatedAt: 0 },
        },
      ],
    });
    expect(parsed.nodes[0]?.data.importedFrom).toMatchObject({
      provider: "libtv",
      nodeKey: "n1",
      sourceType: "material-style",
    });
    expect(parsed.nodes[1]?.data.importedFrom).toBeUndefined();
  });

  it("旧项目没有这个字段照样能读", () => {
    const parsed = canvasProjectSchema.parse({
      ...project,
      nodes: [
        {
          id: "legacy",
          type: "weftcanvas",
          position: { x: 0, y: 0 },
          data: { kind: "text", createdAt: 1, updatedAt: 2, music: null },
        },
      ],
    });
    expect(parsed.nodes[0]?.data.kind).toBe("text");
  });
});
