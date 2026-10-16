import { describe, expect, it, vi } from "vitest";

import { CanvasImportError } from "./adapt.js";
import { canvasImportProviderStatus, loadCanvasImportPreview } from "./service.js";

const TAPNOW_SHARE = "https://app.tapnow.media/tapflow/view/Share-1";
const UPDREAM_SHARE = "share://abc123";
const LIBTV_UUID = "0123456789abcdef0123456789abcdef";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TAPNOW_PAYLOAD = {
  code: 0,
  data: {
    name: "短剧画布",
    nodes: [
      {
        id: "n1",
        type: "image",
        data: {
          title: "场景",
          src: "https://files.tapnow.media/a.png",
          __metadata: { width: 1024, height: 1024 },
        },
        position: { x: 0, y: 0 },
        measured: { width: 360, height: 360 },
      },
    ],
    connections: [],
  },
};

const UPDREAM_PAYLOAD = {
  type: "canvas-nodes",
  nodes: [
    {
      id: 7,
      node_type: "text",
      name: "脚本",
      content: "开场",
      x: 0,
      y: 0,
      size: { width: 300, height: 180 },
    },
  ],
  connections: [],
};

describe("来源可用性", () => {
  it("缺令牌时 LibTV 报不可用并说明差什么，另两个公开来源始终可用", () => {
    const statuses = canvasImportProviderStatus({});
    expect(statuses.map((status) => [status.provider, status.available])).toEqual([
      ["libtv", false],
      ["tapnow", true],
      ["updream", true],
    ]);
    expect(statuses[0]?.reason).toContain("LIBTV_CANVAS_TOKEN");
    expect(canvasImportProviderStatus({ libtvToken: "t" })[0]).toEqual({
      provider: "libtv",
      available: true,
      reason: "",
    });
  });
});

describe("读取来源画布", () => {
  it("TapNow：读公开分享并换成同源素材路径", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(TAPNOW_PAYLOAD));
    const preview = await loadCanvasImportPreview(
      { provider: "tapnow", reference: TAPNOW_SHARE },
      { fetch: fetchMock as unknown as typeof globalThis.fetch },
      { now: () => 1_700_000_000_000, createId: () => "abcdefgh-0000-4000-8000-000000000000" },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.tapnow.media/api/conversation/v1/canvas-share/Share-1",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(preview).toMatchObject({
      provider: "tapnow",
      sourceId: "Share-1",
      projectName: "短剧画布",
      batchId: expect.stringContaining("tapnow-"),
    });
    const asset = preview.nodes[0]?.asset;
    expect(asset?.path.startsWith("/api/v1/canvas-import/asset?")).toBe(true);
    expect(asset?.path).toContain("p=tapnow");
    expect(asset?.path).toContain(encodeURIComponent("https://files.tapnow.media/a.png"));
    // 上游直链不出现在回给浏览器的载荷里。
    expect(JSON.stringify(preview)).not.toContain("https://files.tapnow.media/a.png");
  });

  it("UpDream：口令取画布节点，过期口令如实报错", async () => {
    const items = await loadCanvasImportPreview(
      { provider: "updream", reference: UPDREAM_SHARE },
      { fetch: (async () => jsonResponse(UPDREAM_PAYLOAD)) as unknown as typeof globalThis.fetch },
      { now: () => 1_700_000_000_000, createId: () => "abcdefgh" },
    );
    expect(items.nodes[0]).toMatchObject({ kind: "text", body: "开场" });

    await expect(
      loadCanvasImportPreview(
        { provider: "updream", reference: UPDREAM_SHARE },
        {
          fetch: (async () =>
            jsonResponse({ expired: true })) as unknown as typeof globalThis.fetch,
        },
      ),
    ).rejects.toThrowError(/分享口令已过期/);
  });

  it("LibTV：没令牌不发请求，直接说清还差哪一步", async () => {
    const fetchMock = vi.fn();
    await expect(
      loadCanvasImportPreview(
        { provider: "libtv", reference: LIBTV_UUID },
        { fetch: fetchMock as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_PROVIDER_UNAVAILABLE", status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("LibTV：令牌走请求头，不落进 URL，也不回给浏览器", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchMock = async (input: string | URL, init?: RequestInit) => {
      calls.push({
        url: input.toString(),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return jsonResponse({
        code: 0,
        data: {
          projectMeta: {
            uuid: LIBTV_UUID,
            name: "分镜",
            effective: { canRead: true, canCopy: true },
          },
          nodeList: [
            {
              nodeKey: "n1",
              name: "首帧",
              data: JSON.stringify({ type: "image", url: ["https://libtv-res.liblib.art/a.png"] }),
              position: { positionX: "0", positionY: "0" },
              measured: { width: "360", height: "360" },
            },
          ],
          connectionList: [],
        },
      });
    };
    const preview = await loadCanvasImportPreview(
      { provider: "libtv", reference: `${LIBTV_UUID}` },
      { libtvToken: "libtv-secret", fetch: fetchMock as unknown as typeof globalThis.fetch },
      { now: () => 1_700_000_000_000, createId: () => "abcdefgh" },
    );
    expect(calls[0]?.url).toBe(
      `https://api.liblib.tv/api/canvas/project/detail?uuid=${LIBTV_UUID}`,
    );
    expect(calls[0]?.headers.token).toBe("libtv-secret");
    expect(JSON.stringify(preview)).not.toContain("libtv-secret");
  });

  it("标识认不出来时不发请求", async () => {
    const fetchMock = vi.fn();
    await expect(
      loadCanvasImportPreview(
        { provider: "tapnow", reference: "https://evil.example.com/tapflow/view/x" },
        { fetch: fetchMock as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_REFERENCE_INVALID", status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("对方业务错误原样转给用户，网络与超时各有说法", async () => {
    await expect(
      loadCanvasImportPreview(
        { provider: "tapnow", reference: "Share-1" },
        {
          fetch: (async () =>
            jsonResponse({ code: 40004, msg: "分享已关闭" })) as unknown as typeof globalThis.fetch,
        },
      ),
    ).rejects.toThrowError("分享已关闭");

    await expect(
      loadCanvasImportPreview(
        { provider: "tapnow", reference: "Share-1" },
        {
          fetch: (async () => {
            throw new Error("offline");
          }) as unknown as typeof globalThis.fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_SOURCE_UNAVAILABLE" });

    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    await expect(
      loadCanvasImportPreview(
        { provider: "tapnow", reference: "Share-1" },
        {
          fetch: (async () => {
            throw abortError;
          }) as unknown as typeof globalThis.fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_SOURCE_TIMEOUT" });
  });

  it("响应体超过上限时拒绝，避免把大载荷读进内存", async () => {
    const huge = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(9 << 20));
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    await expect(
      loadCanvasImportPreview(
        { provider: "libtv", reference: LIBTV_UUID },
        { libtvToken: "t", fetch: (async () => huge) as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toBeInstanceOf(CanvasImportError);
  });
});
