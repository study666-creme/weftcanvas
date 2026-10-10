import { expect, test } from "./zero-cost-test";

const projectId = "clip-node-project";

function svgImage(label: string, color: string) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">',
    `<rect width="320" height="180" fill="${color}"/>`,
    `<text x="140" y="100" font-size="54" fill="#ffffff" text-anchor="middle">${label}</text>`,
    "</svg>",
  ].join("");
}

/** 无 API 环境下固定一个空的模型目录，确保画布启动确定性地走完 catalog 阶段。 */
async function mockEmptyCatalog(page: import("@playwright/test").Page) {
  await page.route("**/api/v1/model-catalog**", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "e2e",
        capabilityVersion: "1",
        pricingVersion: "1",
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        quoteAvailable: false,
        models: [],
      },
    },
  }));
}

/**
 * 进入画布并等待启动场景结束。冷启动的 Vite 首次转换可能让画布启动超时，
 * 在「画布启动没有完成」或超长的加载场景下重载重试，最多 2 次。
 */
async function enterCanvas(page: import("@playwright/test").Page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto("/canvas");
    await page.waitForSelector(".kc-canvas-entry-loader", { state: "attached", timeout: 25_000 }).catch(() => undefined);
    await page.waitForSelector(".kc-canvas-entry-loader", { state: "detached", timeout: 25_000 }).catch(() => undefined);
    const failed = await page.getByText("画布启动没有完成").count();
    if (!failed) return;
  }
  throw new Error("画布启动未能在 3 次尝试内完成");
}

test("剪辑节点: 素材栏收录链接节点素材，双击打开工作台并完成增删裁剪重排", async ({ page }) => {
  const timestamp = Date.now();
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await mockEmptyCatalog(page);
  await page.route("**/api/v1/media/image-a/content**", (route) => route.fulfill({
    body: Buffer.from(svgImage("A", "#3b5b8c")),
    contentType: "image/svg+xml",
  }));
  await page.route("**/api/v1/media/image-b/content**", (route) => route.fulfill({
    body: Buffer.from(svgImage("B", "#8c6a3b")),
    contentType: "image/svg+xml",
  }));

  await page.addInitScript(({ projectId, timestamp }) => {
    localStorage.clear();
    const generation = {
      modelId: null,
      parameters: {},
      referenceImagePurposes: {},
      maxOutputTokens: null,
      referenceMode: "auto",
      referenceNodeIds: [],
      jobId: null,
      jobVersion: null,
      jobCreatedAt: null,
      jobStatus: null,
      error: null,
    };
    const media = (id, name) => ({
      id,
      name,
      mimeType: "image/svg+xml",
      size: 160,
      source: "server",
      serverId: id,
      width: 320,
      height: 180,
      durationMs: null,
    });
    const baseNode = (id, kind, position, overrides = {}) => ({
      id,
      type: "kachang",
      position,
      width: 340,
      height: kind === "edit" ? 192 : 214,
      data: {
        kind,
        body: "",
        accent: kind === "edit" ? "blue" : "jade",
        status: "idle",
        progress: null,
        media: null,
        directorCapture: null,
        config: null,
        generation,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...overrides,
      },
    });
    const project = {
      schemaVersion: 1,
      id: projectId,
      name: "剪辑节点",
      nodes: [
        baseNode("img-node-a", "image", { x: 80, y: 200 }, { media: media("image-a", "画面A.svg"), status: "success" }),
        baseNode("img-node-b", "image", { x: 80, y: 440 }, { media: media("image-b", "画面B.svg"), status: "success" }),
        baseNode("edit-node", "edit", { x: 520, y: 300 }),
      ],
      edges: [
        { id: "edge-a", source: "img-node-a", target: "edit-node" },
        { id: "edge-b", source: "img-node-b", target: "edit-node" },
      ],
      groups: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    localStorage.setItem(`kachang-canvas:project-data:v1:${encodeURIComponent(projectId)}`, JSON.stringify(project));
    localStorage.setItem("kachang-canvas:projects:v1", JSON.stringify({
      version: 1,
      projects: [{ id: projectId, name: "剪辑节点", createdAt: timestamp, updatedAt: timestamp, nodeCount: 3 }],
    }));
    localStorage.setItem("kachang-canvas:active-project:v1", projectId);
  }, { projectId, timestamp });

  await enterCanvas(page);

  const editNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="edit"])');
  await expect(editNode).toBeVisible();

  // 双击打开剪辑工作台
  await editNode.locator(".kc-edit-node-preview").dblclick();
  const editor = page.getByTestId("clip-editor");
  await expect(editor).toBeVisible();

  // 左侧素材栏收集两个链接节点
  await expect(page.getByTestId("clip-asset-image-a")).toBeVisible();
  await expect(page.getByTestId("clip-asset-image-b")).toBeVisible();

  // 空时间线提示
  await expect(editor.locator(".kc-clip-stage-empty")).toBeVisible();

  // 加入两个素材（图片默认 3 秒）
  await page.getByTestId("clip-add-image-a").click();
  await expect(page.locator(".kc-clip")).toHaveCount(1);
  await expect(editor.locator(".kc-clip-editor-head-meta")).toContainText("总时长 00:03");

  await page.getByTestId("clip-add-image-b").click();
  await expect(page.locator(".kc-clip")).toHaveCount(2);
  await expect(editor.locator(".kc-clip-editor-head-meta")).toContainText("总时长 00:06");

  // 图片素材必须真的被画进预览画布（曾经图片分支永远画不出内容，只剩黑底）。
  const stageCanvas = page.getByTestId("clip-stage").locator("canvas");
  const litRatio = () => stageCanvas.evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset]! > 20 || pixels[offset + 1]! > 20 || pixels[offset + 2]! > 20) lit += 1;
    }
    return lit / (pixels.length / 4);
  });
  await expect.poll(litRatio, { timeout: 10_000 }).toBeGreaterThan(0.5);

  // 第一帧贴最左：片段左缘与轨道原点共用同一个 0 点。
  const laneBox = await editor.locator(".kc-clip-lane-clips").first().boundingBox();
  const firstClipBox = await page.locator(".kc-clip").first().boundingBox();
  expect(laneBox).not.toBeNull();
  expect(firstClipBox).not.toBeNull();
  expect(Math.abs(firstClipBox!.x - laneBox!.x)).toBeLessThan(2);

  // 播放头回到起点时必须正好落在第一帧上（曾经标尺与轨道差着一整段标签栏）。
  await editor.locator(".kc-clip-seek").fill("0");
  await expect(editor.locator(".kc-clip-playhead")).toHaveAttribute("style", /translateX\(0px\)/);
  const playheadBox = await editor.locator(".kc-clip-playhead").boundingBox();
  expect(playheadBox).not.toBeNull();
  expect(Math.abs(playheadBox!.x - laneBox!.x)).toBeLessThan(2);

  // 时间线缩放：放大一档片段按比例变宽，长素材不用横向翻页。
  await editor.getByLabel("放大时间线").click();
  await expect(editor.getByTestId("clip-zoom-value")).toHaveText("150%");
  await expect.poll(async () => (await page.locator(".kc-clip").first().boundingBox())?.width ?? 0)
    .toBeGreaterThan(firstClipBox!.width * 1.4);
  await editor.getByLabel("缩小时间线").click();
  await expect(editor.getByTestId("clip-zoom-value")).toHaveText("100%");

  // 选中并删除第一段
  const firstClip = page.locator(".kc-clip").first();
  await firstClip.click();
  await expect(firstClip).toHaveClass(/is-selected/);
  await firstClip.locator(".kc-clip-remove").click();
  await expect(page.locator(".kc-clip")).toHaveCount(1);
  await expect(editor.locator(".kc-clip-editor-head-meta")).toContainText("总时长 00:03");

  // 重新加入 A，然后裁剪第一段右边缘 +2 秒
  await page.getByTestId("clip-add-image-a").click();
  await expect(page.locator(".kc-clip")).toHaveCount(2);
  const clipA = page.locator(".kc-clip", { hasText: "画面A.svg" }).first();
  await clipA.click();
  const rightHandle = clipA.locator(".kc-clip-trim--right");
  const handleBox = await rightHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 96, handleBox!.y + handleBox!.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(editor.locator(".kc-clip-editor-head-meta")).toContainText("总时长 00:08");

  // 拖动重排：把第二段（B）拖到 A 之前
  const clipB = page.locator(".kc-clip", { hasText: "画面B.svg" }).first();
  const clipABox = await clipA.boundingBox();
  const clipBBox = await clipB.boundingBox();
  expect(clipABox).not.toBeNull();
  expect(clipBBox).not.toBeNull();
  await page.mouse.move(clipBBox!.x + clipBBox!.width / 2, clipBBox!.y + clipBBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(clipABox!.x + 10, clipBBox!.y + clipBBox!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".kc-clip").first().locator("strong")).toHaveText("画面B.svg");

  // 播放：时间前进
  await page.getByTestId("clip-play").click();
  await expect.poll(async () => {
    const text = await page.getByTestId("clip-timecode").textContent();
    return (text ?? "").split(" / ")[0];
  }, { timeout: 8_000 }).not.toBe("00:00");
  await page.getByTestId("clip-play").click();

  // 关闭并重开：合成已持久化在节点数据里
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await editNode.locator(".kc-edit-node-preview").dblclick();
  await expect(page.getByTestId("clip-editor")).toBeVisible();
  await expect(page.locator(".kc-clip")).toHaveCount(2);
  await expect(page.getByTestId("clip-editor").locator(".kc-clip-editor-head-meta")).toContainText("总时长 00:08");

  // 空格键播放：点过"加入"后焦点会留在按钮上，曾经空格被按钮吃掉（再多加一段、
  // 却不起播）。现在加入后主动 blur，空格必须直接起播。
  await page.getByTestId("clip-add-image-b").click();
  await expect(page.locator(".kc-clip")).toHaveCount(3);
  await page.keyboard.press(" ");
  await expect(page.getByTestId("clip-play")).toHaveAttribute("aria-label", "暂停");
  await expect(page.locator(".kc-clip")).toHaveCount(3);
});

test("剪辑节点: 导出生成连接的视频节点", async ({ page }) => {
  test.setTimeout(90_000);
  const timestamp = Date.now();
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await mockEmptyCatalog(page);
  await page.route("**/api/v1/media/image-a/content**", (route) => route.fulfill({
    body: Buffer.from(svgImage("A", "#3b5b8c")),
    contentType: "image/svg+xml",
  }));

  await page.addInitScript(({ projectId, timestamp }) => {
    localStorage.clear();
    const generation = {
      modelId: null,
      parameters: {},
      referenceImagePurposes: {},
      maxOutputTokens: null,
      referenceMode: "auto",
      referenceNodeIds: [],
      jobId: null,
      jobVersion: null,
      jobCreatedAt: null,
      jobStatus: null,
      error: null,
    };
    const project = {
      schemaVersion: 1,
      id: projectId,
      name: "剪辑导出",
      nodes: [
        {
          id: "img-node-a",
          type: "kachang",
          position: { x: 80, y: 200 },
          width: 340,
          height: 214,
          data: {
            kind: "image",
            body: "",
            accent: "jade",
            status: "success",
            progress: null,
            media: { id: "image-a", name: "画面A.svg", mimeType: "image/svg+xml", size: 160, source: "server", serverId: "image-a", width: 320, height: 180, durationMs: null },
            directorCapture: null,
            config: null,
            generation,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
        {
          id: "edit-node",
          type: "kachang",
          position: { x: 520, y: 300 },
          width: 340,
          height: 192,
          data: {
            kind: "edit",
            body: "",
            accent: "blue",
            status: "idle",
            progress: null,
            media: null,
            directorCapture: null,
            config: null,
            edit: {
              clips: [{
                id: "clip-export-1",
                track: "video",
                nodeId: "img-node-a",
                mediaId: "image-a",
                name: "画面A.svg",
                kind: "image",
                sourceDurationMs: null,
                inMs: 0,
                outMs: 2000,
              }],
            },
            generation,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
      ],
      edges: [{ id: "edge-a", source: "img-node-a", target: "edit-node" }],
      groups: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    localStorage.setItem(`kachang-canvas:project-data:v1:${encodeURIComponent(projectId)}`, JSON.stringify(project));
    localStorage.setItem("kachang-canvas:projects:v1", JSON.stringify({
      version: 1,
      projects: [{ id: projectId, name: "剪辑导出", createdAt: timestamp, updatedAt: timestamp, nodeCount: 2 }],
    }));
    localStorage.setItem("kachang-canvas:active-project:v1", projectId);
  }, { projectId, timestamp });

  await enterCanvas(page);
  const editNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="edit"])');
  await expect(editNode).toBeVisible();
  await editNode.locator(".kc-edit-node-preview").dblclick();
  await expect(page.getByTestId("clip-editor")).toBeVisible();
  await expect(page.locator(".kc-clip")).toHaveCount(1);

  await page.getByTestId("clip-export").click();
  await expect(page.getByText(/导出完成/)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="video"])')).toHaveCount(1);
});
