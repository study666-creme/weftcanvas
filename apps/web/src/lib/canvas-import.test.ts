import type { CanvasImportPreview } from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import {
  fitImportedSize,
  importedNodeData,
  planImportedGraph,
  viewportCenterInFlow,
} from "./canvas-import";

function preview(overrides: Partial<CanvasImportPreview> = {}): CanvasImportPreview {
  return {
    provider: "tapnow",
    sourceId: "Share-1",
    projectName: "短剧画布",
    batchId: "tapnow-abc12345",
    nodes: [
      {
        key: "n1",
        kind: "text",
        title: "开场",
        body: "深夜的医院走廊",
        prompt: "",
        model: "",
        position: { x: 0, y: 0 },
        width: 300,
        height: 180,
        status: "success",
        error: "",
        sourceType: "text",
        asset: null,
      },
      {
        key: "n2",
        kind: "image",
        title: "场景图",
        body: "",
        prompt: "深夜医院",
        model: "seedream",
        position: { x: 400, y: 0 },
        width: 360,
        height: 360,
        status: "success",
        error: "",
        sourceType: "image",
        asset: {
          path: "/api/v1/canvas-import/asset?p=tapnow&u=x",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          durationMs: null,
        },
      },
    ],
    edges: [{ key: "e1", source: "n1", target: "n2" }],
    skipped: [],
    warnings: [],
    ...overrides,
  };
}

describe("导入布局规划", () => {
  it("整块居中到锚点，相对位置与来源一致", () => {
    const plan = planImportedGraph(preview(), { x: 1_000, y: 500 });
    // 来源包围盒 x∈[0,760]、y∈[0,360]，中心 (380,180) ⇒ 平移 (+620,+320)。
    expect(plan.nodes.map((node) => node.position)).toEqual([
      { x: 620, y: 320 },
      { x: 1_020, y: 320 },
    ]);
    expect(plan.nodes[0]?.position.x! - plan.nodes[1]?.position.x!).toBe(-400);
  });

  it("连线按 key 映射成插入下标，端点缺失的连线丢掉", () => {
    const plan = planImportedGraph(
      preview({
        edges: [
          { key: "e1", source: "n1", target: "n2" },
          { key: "e2", source: "n1", target: "unknown" },
        ],
      }),
      { x: 0, y: 0 },
    );
    expect(plan.edges).toEqual([{ sourceIndex: 0, targetIndex: 1 }]);
  });

  it("空画布给空计划，不炸", () => {
    expect(planImportedGraph(preview({ nodes: [], edges: [] }), { x: 0, y: 0 })).toEqual({
      nodes: [],
      edges: [],
    });
  });
});

describe("导入节点尺寸", () => {
  it("超过可读长边时按比例收进来", () => {
    expect(fitImportedSize({ width: 2_048, height: 1_024 })).toEqual({ width: 720, height: 360 });
    expect(fitImportedSize({ width: 360, height: 540 })).toEqual({ width: 360, height: 540 });
  });

  it("过小的节点抬到最小可读尺寸且保持比例", () => {
    // 2:1 的小节点：最短边抬到 120 ⇒ 240×120。
    expect(fitImportedSize({ width: 90, height: 45 })).toEqual({ width: 240, height: 120 });
    // 1:5 的细长条：抬到最短边 120 会得到 600 高，仍在长边上限内。
    expect(fitImportedSize({ width: 40, height: 200 })).toEqual({ width: 120, height: 600 });
    // 1:10 这种极端比例下两个约束冲突，以长边上限为准（宁可细，不能超出可读框）。
    expect(fitImportedSize({ width: 30, height: 300 })).toEqual({ width: 72, height: 720 });
  });

  it("坏尺寸回落到默认尺寸", () => {
    expect(fitImportedSize({ width: 0, height: Number.NaN })).toEqual({
      width: 180,
      height: 120,
    });
  });
});

describe("导入节点数据", () => {
  it("文本节点落正文，媒体节点落来源提示词与导入来源", () => {
    const data = preview();
    const text = importedNodeData(data.nodes[0]!, data, 1_700_000_000_000);
    expect(text.body).toBe("深夜的医院走廊");
    expect(text.uploading).toBeUndefined();
    expect(text.importedFrom).toEqual({
      provider: "tapnow",
      sourceId: "Share-1",
      sourceName: "短剧画布",
      nodeKey: "n1",
      batchId: "tapnow-abc12345",
      sourceType: "text",
      importedAt: 1_700_000_000_000,
    });

    const image = importedNodeData(data.nodes[1]!, data, 1_700_000_000_000);
    expect(image.body).toBe("深夜医院");
    // 有素材的节点先挂"取素材中"，取到后由调用方置回 false。
    expect(image.uploading).toBe(true);
    expect(image.status).toBe("idle");
  });

  it("对方失败的节点如实带上失败原因，不伪装成成功", () => {
    const data = preview({
      nodes: [
        {
          ...preview().nodes[1]!,
          status: "error",
          error: "内容被拒",
          asset: null,
        },
      ],
    });
    const seed = importedNodeData(data.nodes[0]!, data);
    expect(seed.status).toBe("error");
    expect(seed.generation?.error).toBe("内容被拒");
    expect(seed.uploading).toBeUndefined();
  });
});

describe("视口中心换算", () => {
  it("按平移与缩放把屏幕中心换成画布坐标", () => {
    expect(viewportCenterInFlow({ x: -100, y: -50, zoom: 2 }, { width: 800, height: 600 })).toEqual(
      {
        x: 250,
        y: 175,
      },
    );
    // 缩放非法时按 1 处理，不产生 NaN 坐标。
    expect(viewportCenterInFlow({ x: 0, y: 0, zoom: 0 }, { width: 800, height: 600 })).toEqual({
      x: 400,
      y: 300,
    });
  });
});
