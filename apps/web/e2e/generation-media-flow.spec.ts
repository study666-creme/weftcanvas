import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";

// 节点生成面板路径：两个并行节点一个慢速一个失效，媒体在完整 decode 前只显示
// 固定占位，画布平移缩放保持即时；成功后原子替换、失败保持可重试错误状态。
const visiblePng = readFileSync(new URL("../src/assets/resource-library-mark.png", import.meta.url));

const now = new Date();
const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();

const session = {
  user: {
    id: "07d3b269-6bc3-4dbb-b67f-28664c787f00",
    email: "creator@example.com",
    displayName: "创作者",
    createdAt: now.toISOString(),
  },
  expiresAt,
};

const emptyCatalog = {
  version: "node-media-catalog",
  capabilityVersion: "node-media-capability",
  pricingVersion: "node-media-pricing",
  fetchedAt: now.toISOString(),
  expiresAt,
  quoteAvailable: false,
  models: [],
};

function runningJob(id: string, nodeId: string) {
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    version: 1,
    id,
    projectId: "project-node-media",
    nodeId,
    modelId: "image-batch",
    modelLabel: "批量图片模型",
    modality: "image",
    status: "running",
    progress: 30,
    quote: {
      id: `quote-${id}`,
      modelId: "image-batch",
      modelLabel: "批量图片模型",
      modality: "image",
      quantity: 1,
      normalizedParameters: { prompt: "节点图片", n: 1 },
      creditMicros: 2_000_000,
      credits: "2",
      yuanMicros: 20_000,
      yuan: "0.02",
      estimated: false,
      pricingUnit: "image",
      catalogVersion: "node-media-catalog",
      capabilityVersion: "node-media-capability",
      pricingVersion: "node-media-pricing",
      expiresAt,
    },
    artifacts: [],
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: null,
  };
}

function completedJob(id: string, nodeId: string, mediaId: string, mimeType: string, size: number) {
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    version: 4,
    id,
    projectId: "project-node-media",
    nodeId,
    modelId: "image-batch",
    modelLabel: "批量图片模型",
    modality: "image",
    status: "completed",
    progress: 100,
    quote: runningJob(id, nodeId).quote,
    artifacts: [{
      id: `artifact-${id}`,
      kind: "image",
      mediaId,
      name: "result.png",
      mimeType,
      size,
      width: 128,
      height: 128,
      createdAt,
    }],
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
  };
}

async function seedRunningNodes(page: Page) {
  const time = Date.now();
  const projectId = "project-node-media";
  const generation = {
    modelId: "image-batch",
    parameters: { n: 1 },
    maxOutputTokens: null,
    referenceMode: "auto",
    referenceNodeIds: [],
    jobId: null,
    jobVersion: null,
    jobCreatedAt: null,
    jobStatus: null,
    error: null,
  };
  const node = (id: string, jobId: string, y: number) => ({
    id,
    type: "kachang",
    position: { x: 20, y },
    width: 340,
    height: 214,
    selected: false,
    data: {
      kind: "image",
      body: "节点生成结果",
      accent: "blue",
      status: "running",
      progress: 30,
      media: null,
      directorCapture: null,
      config: null,
      generation: {
        ...generation,
        jobId,
        jobVersion: 1,
        jobCreatedAt: now.toISOString(),
        jobStatus: "running",
      },
      createdAt: time,
      updatedAt: time,
    },
  });
  const project = {
    schemaVersion: 1,
    id: projectId,
    name: "Node media generation flow",
    nodes: [
      node("node-slow", "job-slow", 80),
      node("node-broken", "job-broken", 420),
    ],
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: time,
    updatedAt: time,
  };
  await page.addInitScript((seed) => {
    localStorage.clear();
    localStorage.setItem(`kachang-canvas:project-data:v1:${encodeURIComponent(seed.id)}`, JSON.stringify(seed));
    localStorage.setItem("kachang-canvas:projects:v1", JSON.stringify({
      version: 1,
      projects: [{ id: seed.id, name: seed.name, createdAt: seed.createdAt, updatedAt: seed.updatedAt, nodeCount: seed.nodes.length }],
    }));
    localStorage.setItem("kachang-canvas:active-project:v1", seed.id);
  }, project);
}

async function mockNodeMediaApis(page: Page) {
  await mockAuthenticatedBackgroundApis(page);
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  let imageReads = 0;
  let brokenReads = 0;
  let posts = 0;

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: session } }));
  await page.route("**/api/v1/wallet", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        credits: 100,
        creditsPermanent: 100,
        dailyCredits: 0,
        creditGrantMode: "bundle",
        dailyCreditsNote: "",
        membership: { tier: null, until: null, active: false, genDiscount: null },
        lifetimeCreditsSpent: 0,
      },
    },
  }));
  await page.route("**/api/v1/model-catalog*", (route) => route.fulfill({ json: { ok: true, data: emptyCatalog } }));
  await page.route("**/api/v1/generation-jobs?*", (route) => route.fulfill({
    json: {
      ok: true,
      data: [runningJob("job-slow", "node-slow"), runningJob("job-broken", "node-broken")],
    },
  }));
  await page.route("**/api/v1/generation-jobs/job-slow/events", (route) => {
    const job = completedJob("job-slow", "node-slow", "node-media-slow", "image/png", visiblePng.byteLength);
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: `id: generation:job-slow:4\nevent: job\ndata: ${JSON.stringify({ type: "job", job })}\n\n`,
    });
  });
  await page.route("**/api/v1/generation-jobs/job-broken/events", (route) => {
    const job = completedJob("job-broken", "node-broken", "node-media-broken", "image/png", 1);
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: `id: generation:job-broken:4\nevent: job\ndata: ${JSON.stringify({ type: "job", job })}\n\n`,
    });
  });
  await page.route("**/api/v1/generation-jobs/job-slow", (route) => route.fulfill({
    json: { ok: true, data: runningJob("job-slow", "node-slow") },
  }));
  await page.route("**/api/v1/generation-jobs/job-broken", (route) => route.fulfill({
    json: { ok: true, data: runningJob("job-broken", "node-broken") },
  }));
  await page.route("**/api/v1/media/node-media-slow/content*", async (route) => {
    imageReads += 1;
    await slowGate;
    await route.fulfill({ body: visiblePng, contentType: "image/png" });
  });
  await page.route("**/api/v1/media/node-media-broken/content*", (route) => {
    brokenReads += 1;
    return route.fulfill({ status: 404, body: "not found" });
  });

  return { releaseSlow, readImageReads: () => imageReads, readBrokenReads: () => brokenReads, readPosts: () => posts };
}

async function imageNonBlackRatio(image: Locator) {
  if (!(await image.count())) return 0;
  return image.evaluate((element) => {
    if (!(element instanceof HTMLImageElement) || !element.complete || !element.naturalWidth || !element.naturalHeight) return 0;
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable");
    context.drawImage(element, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlack = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 0 && (pixels[index] > 8 || pixels[index + 1] > 8 || pixels[index + 2] > 8)) nonBlack += 1;
    }
    return nonBlack / (canvas.width * canvas.height);
  });
}

test("parallel node generation keeps the canvas interactive: one slow decodes atomically, one fails truthfully", async ({ page }, testInfo) => {
  await seedRunningNodes(page);
  const mocks = await mockNodeMediaApis(page);
  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 8_000 });

  const slowNode = page.locator('.react-flow__node-kachang[data-id="node-slow"]');
  const brokenNode = page.locator('.react-flow__node-kachang[data-id="node-broken"]');

  // 慢速节点：decode 前只有固定占位，img 不可见；失效节点：显式错误占位。
  await expect(slowNode.getByText("结果已生成，正在载入")).toBeVisible();
  await expect.poll(mocks.readImageReads).toBeGreaterThan(0);
  await expect(slowNode.locator("img")).toBeHidden();
  await expect(brokenNode.getByText("结果加载失败")).toBeVisible();
  await expect.poll(mocks.readBrokenReads).toBeGreaterThan(0);

  const slowBoxWhileLoading = await slowNode.boundingBox();
  await page.waitForTimeout(350);
  const slowBoxWhileLoadingAgain = await slowNode.boundingBox();
  expect(slowBoxWhileLoading).not.toBeNull();
  expect(slowBoxWhileLoadingAgain).not.toBeNull();
  expect(Math.round(slowBoxWhileLoading!.width)).toBe(Math.round(slowBoxWhileLoadingAgain!.width));
  expect(Math.round(slowBoxWhileLoading!.height)).toBe(Math.round(slowBoxWhileLoadingAgain!.height));

  // decode 期间画布平移仍然即时生效（Space + 鼠标拖拽从空白区域开始）。
  const readViewport = () => page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42 };
  });
  const viewportBefore = await readViewport();
  const pane = page.locator(".react-flow__pane");
  const bounds = await pane.boundingBox();
  expect(bounds).not.toBeNull();
  const start = { x: bounds!.x + bounds!.width * 0.9, y: bounds!.y + bounds!.height * 0.72 };
  await page.keyboard.down("Space");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 90, start.y - 40, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect.poll(readViewport).not.toEqual(viewportBefore);

  await page.screenshot({ path: testInfo.outputPath("node-parallel-loading-during-pan.png") });

  mocks.releaseSlow();
  const slowImage = slowNode.locator("img[data-media-id='node-media-slow']");
  await expect(slowImage).toBeVisible();
  await expect.poll(() => imageNonBlackRatio(slowImage)).toBeGreaterThan(0.02);
  await expect(slowNode.getByText("结果已生成，正在载入")).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(slowNode.locator("img")).toHaveCount(1);

  const slowBoxAfter = await slowNode.boundingBox();
  expect(Math.round(slowBoxAfter!.width)).toBe(Math.round(slowBoxWhileLoading!.width));
  expect(Math.round(slowBoxAfter!.height)).toBe(Math.round(slowBoxWhileLoading!.height));

  // 一项成功一项失败：失败节点保留显式错误，没有被成功节点覆盖。
  await expect(brokenNode.getByText("结果加载失败")).toBeVisible();
  const brokenImage = brokenNode.locator("img[data-media-id='node-media-broken']");
  await expect(brokenImage).toBeHidden();
  expect(await brokenImage.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(0);

  // 只恢复/观察既有任务，不产生任何新的提交。
  expect(mocks.readPosts()).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("node-parallel-settled.png") });
});

test("mobile parallel node generation keeps fixed geometry and stays atomic", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRunningNodes(page);
  const mocks = await mockNodeMediaApis(page);
  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 8_000 });

  const slowNode = page.locator('.react-flow__node-kachang[data-id="node-slow"]');
  const brokenNode = page.locator('.react-flow__node-kachang[data-id="node-broken"]');
  await expect(slowNode.getByText("结果已生成，正在载入")).toBeVisible();
  await expect(slowNode.locator("img")).toBeHidden();
  await expect(brokenNode.getByText("结果加载失败")).toBeVisible();

  const slowBoxWhileLoading = await slowNode.boundingBox();
  const documentBefore = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(documentBefore.scrollWidth).toBe(documentBefore.width);

  mocks.releaseSlow();
  const slowImage = slowNode.locator("img[data-media-id='node-media-slow']");
  await expect(slowImage).toBeVisible();
  await expect.poll(() => imageNonBlackRatio(slowImage)).toBeGreaterThan(0.02);
  await page.waitForTimeout(300);
  await expect(slowNode.locator("img")).toHaveCount(1);

  const slowBoxAfter = await slowNode.boundingBox();
  expect(Math.round(slowBoxAfter!.width)).toBe(Math.round(slowBoxWhileLoading!.width));
  expect(Math.round(slowBoxAfter!.height)).toBe(Math.round(slowBoxWhileLoading!.height));
  const documentAfter = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(documentAfter.scrollWidth).toBe(documentAfter.width);
  await page.screenshot({ path: testInfo.outputPath("mobile-node-parallel-atomic.png") });
});
