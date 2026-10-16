import { describe, expect, it } from "vitest";

import type { CanvasImportAdapterOptions } from "./adapt.js";
import {
  adaptLibTVCanvas,
  adaptTapNowCanvas,
  adaptUpDreamShare,
  CanvasImportError,
} from "./adapt.js";

const OPTIONS: CanvasImportAdapterOptions = {
  sourceId: "0123456789abcdef0123456789abcdef",
  now: Date.parse("2026-10-16T12:00:00.000Z"),
  createId: () => "6f1c0a5e-0000-4000-8000-000000000000",
};

/** LibTV 详情：nodeList[].data 是 JSON 字符串，坐标/尺寸是字符串。 */
function libtvDetail(nodes: unknown[], connections: unknown[] = []) {
  return {
    projectMeta: {
      uuid: OPTIONS.sourceId,
      name: "分镜画布",
      effective: { canRead: true, canCopy: true },
    },
    nodeList: nodes,
    connectionList: connections,
  };
}

function libtvNode(overrides: Record<string, unknown> = {}) {
  return {
    nodeKey: "n1",
    name: "首帧",
    data: JSON.stringify({
      type: "image",
      url: ["https://libtv-res.liblib.art/first.png"],
      params: { prompt: "一个绝世美人", model: "mj-v6" },
      taskInfo: { status: 2 },
      _resourceMeta: { items: [{ width: 1024, height: 1536, durationSec: 0 }] },
    }),
    position: { positionX: "100", positionY: "220" },
    measured: { width: "360", height: "540" },
    taskInfo: { status: 2 },
    ...overrides,
  };
}

describe("LibTV 画布适配", () => {
  it("图片/视频节点带素材与来源提示词，位置尺寸按来源保留", () => {
    const draft = adaptLibTVCanvas(libtvDetail([libtvNode()]), OPTIONS);
    expect(draft.projectName).toBe("分镜画布");
    expect(draft.batchId).toContain("libtv-");
    expect(draft.nodes).toHaveLength(1);
    const [node] = draft.nodes;
    expect(node).toMatchObject({
      key: "n1",
      kind: "image",
      title: "首帧",
      prompt: "一个绝世美人",
      model: "mj-v6",
      position: { x: 100, y: 220 },
      width: 360,
      height: 540,
      status: "success",
      sourceType: "image",
    });
    expect(node.asset).toEqual({
      url: "https://libtv-res.liblib.art/first.png",
      mimeType: "image/png",
      width: 1024,
      height: 1536,
      durationMs: null,
    });
  });

  it("最近一次任务失败但节点里还有历史结果时保留结果并记提醒", () => {
    const draft = adaptLibTVCanvas(
      libtvDetail([
        libtvNode({
          // 节点数据里的任务态为空（status 0），失败写在节点记录那一份里。
          data: JSON.stringify({
            type: "image",
            url: ["https://libtv-res.liblib.art/first.png"],
            taskInfo: { status: 0 },
          }),
          taskInfo: { status: 3, failedReason: "超时" },
          isStale: true,
        }),
      ]),
      OPTIONS,
    );
    expect(draft.nodes[0]?.status).toBe("success");
    expect(draft.warnings.map((item) => item.message)).toEqual([
      expect.stringContaining("最近一次任务失败"),
      expect.stringContaining("已被标记为过期"),
    ]);
  });

  it("没有结果的失败节点如实标 error，其余留占位", () => {
    const draft = adaptLibTVCanvas(
      libtvDetail([
        libtvNode({
          nodeKey: "failed",
          name: "失败的图",
          data: JSON.stringify({
            type: "image",
            url: [],
            taskInfo: { status: 3, failedReason: "配额不足" },
          }),
        }),
        libtvNode({
          nodeKey: "pending",
          name: "还没跑",
          data: JSON.stringify({ type: "image", url: [], taskInfo: { status: 1 } }),
        }),
      ]),
      OPTIONS,
    );
    expect(draft.nodes.map((node) => [node.key, node.status, node.error])).toEqual([
      ["failed", "error", "配额不足"],
      ["pending", "idle", ""],
    ]);
  });

  it("风格素材降级成图片节点，白名单外的素材地址整条丢弃", () => {
    const draft = adaptLibTVCanvas(
      libtvDetail([
        libtvNode({
          nodeKey: "style",
          name: "风格",
          data: JSON.stringify({
            type: "material-style",
            url: [],
            coverUrl: "https://libtv-res.liblib.art/style.png",
          }),
        }),
        libtvNode({
          nodeKey: "external",
          name: "外链图",
          data: JSON.stringify({
            type: "image",
            url: ["https://evil.example.com/steal.png"],
          }),
        }),
      ]),
      OPTIONS,
    );
    expect(draft.nodes[0]).toMatchObject({ kind: "image", status: "success" });
    expect(draft.nodes[0]?.asset?.url).toBe("https://libtv-res.liblib.art/style.png");
    expect(draft.nodes[1]).toMatchObject({ kind: "image", status: "idle", asset: null });
    expect(draft.warnings.some((item) => item.message.includes("风格素材"))).toBe(true);
  });

  it("跳过不支持的节点类型、坏坐标与重复标识，并逐条说明原因", () => {
    const draft = adaptLibTVCanvas(
      libtvDetail([
        libtvNode({ nodeKey: "audio", name: "音频", data: JSON.stringify({ type: "audio" }) }),
        libtvNode({
          nodeKey: "bad-pos",
          name: "坏坐标",
          position: { positionX: "abc", positionY: "1" },
        }),
        libtvNode({ nodeKey: "dup" }),
        libtvNode({ nodeKey: "dup" }),
        libtvNode({ nodeKey: "", name: "没标识" }),
      ]),
      OPTIONS,
    );
    expect(draft.nodes.map((node) => node.key)).toEqual(["dup"]);
    expect(draft.skipped.map((item) => item.message)).toEqual([
      expect.stringContaining("audio 节点暂不支持导入"),
      expect.stringContaining("坐标无效"),
      expect.stringContaining("节点标识重复"),
      expect.stringContaining("缺少 nodeKey"),
    ]);
  });

  it("连线只保留两端都导入的，重复连线只留一条", () => {
    const draft = adaptLibTVCanvas(
      libtvDetail(
        [
          libtvNode({ nodeKey: "a" }),
          libtvNode({ nodeKey: "b" }),
          libtvNode({ nodeKey: "skip", data: JSON.stringify({ type: "audio" }) }),
        ],
        [
          { connectionId: "c1", source: "a", target: "b" },
          { connectionId: "c1", source: "a", target: "b" },
          { connectionId: "c2", source: "a", target: "skip" },
          { connectionId: "", source: "a", target: "b" },
        ],
      ),
      OPTIONS,
    );
    expect(draft.edges).toEqual([{ key: "c1", source: "a", target: "b" }]);
    expect(draft.skipped.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("端点节点没有导入"),
        expect.stringContaining("连线缺少标识"),
      ]),
    );
  });

  it("对方不允许复制时拒绝导入，没有可导入节点时明确报错", () => {
    expect(() =>
      adaptLibTVCanvas(
        {
          projectMeta: { uuid: OPTIONS.sourceId, name: "私密", effective: { canCopy: false } },
          nodeList: [libtvNode()],
          connectionList: [],
        },
        OPTIONS,
      ),
    ).toThrowError(/不允许复制/);
    expect(() => adaptLibTVCanvas(libtvDetail([]), OPTIONS)).toThrowError(/没有可导入的节点/);
  });
});

describe("TapNow 画布适配", () => {
  const tapnowDetail = {
    id: "share-1",
    name: "TapNow 短剧",
    nodes: [
      {
        id: "node-a",
        short_id: 42,
        type: "text",
        data: JSON.stringify({ title: "开场", text: "深夜的医院走廊", params: { model: "gpt" } }),
        position: { x: 0, y: 0 },
        measured: { width: 320, height: 200 },
      },
      {
        id: "node-b",
        type: "image",
        data: JSON.stringify({
          title: "场景图",
          prompt: "深夜医院",
          src: "https://files.tapnow.media/a.png",
          options: ["https://files.tapnow.media/a.png", "https://files.tapnow.media/a2.png"],
          params: { model: "seedream", aspectRatio: "16:9" },
          __metadata: { width: 1024, height: 1024, duration: 0 },
        }),
        position: { x: 400, y: 0 },
        measured: { width: 360, height: 360 },
      },
      {
        id: "node-c",
        type: "video",
        data: JSON.stringify({
          title: "分镜",
          prompt: "推镜",
          src: "https://files.tapnow.media/c.mp4",
          taskInfo: { status: "failed", message: "上游超时" },
          __metadata: { width: 720, height: 1280, duration: 5 },
        }),
        position: { x: 800, y: 0 },
        measured: { width: 300, height: 533 },
      },
      {
        id: "node-d",
        type: "image",
        data: JSON.stringify({
          title: "失败的图",
          src: "",
          taskInfo: { status: "failed" },
          error: "内容被拒",
        }),
        position: { x: 0, y: 400 },
        measured: { width: 0, height: 0 },
      },
      {
        id: "node-e",
        type: "mesh",
        data: JSON.stringify({ title: "三维节点" }),
        position: { x: 400, y: 400 },
        measured: { width: 100, height: 100 },
      },
      {
        id: "node-f",
        type: "image",
        deleted_at: "2026-10-01T00:00:00.000Z",
        data: "{}",
        position: { x: 1, y: 1 },
      },
    ],
    connections: [
      {
        id: "e1",
        source: "node-a",
        target: "node-b",
        targetHandle: null,
        data: { valueKey: "image" },
      },
      { id: "e2", source: "42", target: "node-c" },
      { id: "e3", source: "node-a", target: "node-e" },
    ],
  };

  it("文本节点带正文，媒体节点带素材，短 id 也能接回连线", () => {
    const draft = adaptTapNowCanvas(tapnowDetail, OPTIONS);
    expect(draft.projectName).toBe("TapNow 短剧");
    expect(draft.nodes.map((node) => [node.key, node.kind, node.status])).toEqual([
      ["node-a", "text", "success"],
      ["node-b", "image", "success"],
      ["node-c", "video", "success"],
      ["node-d", "image", "error"],
    ]);
    const text = draft.nodes[0];
    expect(text?.body).toBe("深夜的医院走廊");
    const image = draft.nodes[1];
    expect(image).toMatchObject({ prompt: "深夜医院", model: "seedream" });
    expect(image?.asset).toMatchObject({
      url: "https://files.tapnow.media/a.png",
      width: 1024,
      height: 1024,
    });
    const video = draft.nodes[2];
    expect(video?.asset?.durationMs).toBe(5_000);
    expect(draft.nodes[3]?.error).toBe("内容被拒");
    expect(draft.edges).toEqual([
      { key: "e1", source: "node-a", target: "node-b" },
      { key: "e2", source: "node-a", target: "node-c" },
    ]);
    expect(draft.skipped.map((item) => item.message)).toEqual([
      expect.stringContaining("mesh 节点暂不支持导入"),
      expect.stringContaining("端点节点没有导入"),
    ]);
    expect(draft.warnings.map((item) => item.message)).toContainEqual(
      expect.stringContaining("最近一次任务失败"),
    );
    expect(draft.warnings.map((item) => item.message)).toContainEqual(
      expect.stringContaining("尺寸无效"),
    );
  });

  it("数据是字符串或对象都能解，缺尺寸时给默认尺寸", () => {
    const draft = adaptTapNowCanvas(
      {
        name: "",
        nodes: [
          {
            id: "n1",
            type: "image",
            data: { title: "对象形式", src: "https://files.tapnow.media/x.webp" },
            position: { x: 10, y: 20 },
            measured: null,
          },
        ],
        connections: [],
      },
      OPTIONS,
    );
    expect(draft.projectName).toBe("TapNow 画布");
    expect(draft.nodes[0]).toMatchObject({ width: 480, height: 300 });
    expect(draft.nodes[0]?.asset?.mimeType).toBe("image/webp");
  });
});

describe("UpDream 分享适配", () => {
  const share = {
    type: "canvas-nodes",
    nodes: [
      {
        id: 11,
        node_type: "text",
        name: "脚本",
        content: "第一场：雨夜",
        x: 0,
        y: 0,
        size: { width: 300, height: 180 },
      },
      {
        id: 12,
        node_type: "image",
        name: "参考图",
        cover_url: "https://s1.hdslb.com/bfs/a.jpg",
        x: 360,
        y: 0,
        size: { width: 384, height: 512 },
        task_status: "success",
      },
      {
        id: 13,
        node_type: "video",
        name: "分镜视频",
        video_url: "https://upos-sz-mirror.bilivideo.com/b.mp4",
        x: 800,
        y: 0,
        task_status: "failed",
      },
      {
        id: 16,
        node_type: "image",
        name: "没出结果的图",
        x: 800,
        y: 400,
        task_status: "failed",
        error: "审核未通过",
      },
      {
        id: 14,
        node_type: "group",
        name: "分组",
        x: 10,
        y: 10,
      },
      {
        id: 15,
        node_type: "agent",
        name: "助手",
        x: 20,
        y: 20,
      },
    ],
    connections: [
      { from_node_id: 11, to_node_id: 12 },
      { from_node_id: 12, to_node_id: 14 },
    ],
  };

  it("文本/图片/视频落地，分组与助手节点跳过并说明原因", () => {
    const draft = adaptUpDreamShare(share, OPTIONS);
    expect(draft.nodes.map((node) => [node.key, node.kind])).toEqual([
      ["11", "text"],
      ["12", "image"],
      ["13", "video"],
      ["16", "image"],
    ]);
    expect(draft.nodes[0]?.body).toBe("第一场：雨夜");
    expect(draft.nodes[0]?.width).toBe(300);
    expect(draft.nodes[1]?.asset?.url).toBe("https://s1.hdslb.com/bfs/a.jpg");
    // 有素材、但对方最近一次任务失败：保留素材并记一条提醒。
    expect(draft.nodes[2]?.status).toBe("success");
    expect(draft.warnings.map((item) => item.message)).toContainEqual(
      expect.stringContaining("最近一次任务失败"),
    );
    // 没有素材且任务失败：保留节点并带上对方的失败原因。
    expect(draft.nodes[3]).toMatchObject({
      status: "error",
      error: "审核未通过",
      asset: null,
    });
    expect(draft.edges).toEqual([{ key: "11-12", source: "11", target: "12" }]);
    expect(draft.skipped.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("group 节点暂不支持导入"),
        expect.stringContaining("agent 节点暂不支持导入"),
        expect.stringContaining("端点节点没有导入"),
      ]),
    );
  });

  it("过期的分享口令给出可执行的提示", () => {
    expect(() => adaptUpDreamShare({ expired: true }, OPTIONS)).toThrowError(/分享口令已过期/);
    expect(() => adaptUpDreamShare({ type: "chat" }, OPTIONS)).toThrowError(/不是画布节点/);
  });

  it("没有可导入节点时明确报错而不是给空画布", () => {
    let error: unknown;
    try {
      adaptUpDreamShare({ type: "canvas-nodes", nodes: [{ id: 1, node_type: "group" }] }, OPTIONS);
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(CanvasImportError);
    expect((error as CanvasImportError).code).toBe("IMPORT_SOURCE_EMPTY");
  });
});
