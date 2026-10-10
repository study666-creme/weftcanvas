import { readFileSync } from "node:fs";
import { expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";

// 使用可见 PNG 覆盖缩略图/节点图片的解码与非黑帧渲染。
const visiblePng = readFileSync(new URL("../src/assets/card-library-logo.png", import.meta.url));

const session = {
  user: {
    id: "77777777-7777-4777-8777-777777777777",
    email: "creator@example.com",
    displayName: "创作者",
    createdAt: "2026-07-22T00:00:00.000Z",
  },
  expiresAt: "2099-08-22T00:00:00.000Z",
};

test.describe("mobile card-library media loading", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await mockAuthenticatedBackgroundApis(page);
    await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: session } }));
    await page.route("**/api/v1/wallet", (route) => route.fulfill({
      json: {
        ok: true,
        data: {
          credits: 0,
          creditsPermanent: 0,
          dailyCredits: 0,
          creditGrantMode: "bundle",
          dailyCreditsNote: "",
          membership: { tier: "free", until: null, active: false, genDiscount: null },
          lifetimeCreditsSpent: 0,
        },
      },
    }));
    await page.route("**/api/v1/generation-jobs?*", (route) => route.fulfill({ json: { ok: true, data: [] } }));
    await page.route("**/api/v1/model-catalog?*", (route) => route.fulfill({
      json: {
        ok: true,
        data: {
          version: "mobile-media-catalog",
          capabilityVersion: "mobile-media-capability",
          pricingVersion: "mobile-media-pricing",
          fetchedAt: "2026-07-22T00:00:00.000Z",
          expiresAt: "2099-08-22T00:00:00.000Z",
          quoteAvailable: false,
          models: [],
        },
      },
    }));
    await page.route("**/api/v1/card-library/groups", (route) => route.fulfill({ json: { ok: true, data: { groups: ["镜头"] } } }));
  });

  test("card thumbnails show explicit loading and unavailable placeholders without black or broken previews", async ({ page }, testInfo) => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let slowFetches = 0;
    let brokenFetches = 0;

    await page.route("**/api/v1/card-library/card-thumbnails/slow.png", async (route) => {
      slowFetches += 1;
      await slowGate;
      await route.fulfill({ body: visiblePng, contentType: "image/png" });
    });
    await page.route("**/api/v1/card-library/card-thumbnails/broken.png", (route) => {
      brokenFetches += 1;
      return route.fulfill({ status: 404, body: "not found" });
    });
    await page.route("**/api/v1/card-library/card-thumbnails/ok.png", (route) => route.fulfill({ body: visiblePng, contentType: "image/png" }));

    const cards = [
      { id: "card-mobile-slow", title: "慢速缩略图卡片", prompt: "缩略图在慢速网络下等待解码。", thumbUrl: "/api/v1/card-library/card-thumbnails/slow.png", hasImage: true },
      { id: "card-mobile-broken", title: "失效缩略图卡片", prompt: "缩略图地址不可达。", thumbUrl: "/api/v1/card-library/card-thumbnails/broken.png", hasImage: true },
      { id: "card-mobile-ok", title: "即时缩略图卡片", prompt: "缩略图立即可见。", thumbUrl: "/api/v1/card-library/card-thumbnails/ok.png", hasImage: true },
    ];
    await page.route("**/api/v1/card-library/cards**", (route) => route.fulfill({
      json: {
        ok: true,
        data: { cards, total: cards.length, page: 1, limit: 18 },
      },
    }));

    await page.goto("/canvas");
    await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
    const drawer = page.getByRole("dialog", { name: "资源库" });
    await expect(drawer).toBeVisible();

    const slowCard = drawer.locator(".kc-card-library-item").filter({ hasText: "慢速缩略图卡片" });
    const slowPreview = slowCard.locator(".kc-card-library-preview");
    await expect(slowPreview).toBeVisible();

    const slowLoading = slowPreview.getByLabel("慢速缩略图卡片 缩略图加载中");
    await expect(slowLoading).toBeVisible();
    const slowBoxWhileLoading = await slowPreview.boundingBox();
    const slowImgWhileLoading = await slowPreview.locator("img").count();
    const slowImgVisibleBefore = await imageNonBlackRatio(slowPreview.locator("img").first());

    const brokenCard = drawer.locator(".kc-card-library-item").filter({ hasText: "失效缩略图卡片" });
    const brokenPreview = brokenCard.locator(".kc-card-library-preview");
    const brokenError = brokenPreview.getByLabel("失效缩略图卡片 缩略图不可用");
    const brokenBox = await brokenPreview.boundingBox();
    await expect.poll(() => brokenFetches).toBeGreaterThan(0);

    await page.screenshot({ path: testInfo.outputPath("mobile-cards-loading-before-release.png") });

    // 加载中的缩略图必须有显式占位，而不是黑盒或悬空图片。
    expect(slowImgWhileLoading).toBe(0);
    expect(slowImgVisibleBefore).toBe(0);

    // 失效缩略图必须是显式占位，而不是浏览器断图图标。
    await expect(brokenError).toBeVisible();
    expect(await brokenPreview.locator("img").count()).toBe(0);

    // 固定几何：加载中和加载完成后的预览框尺寸一致，不发生布局位移。
    releaseSlow();
    await expect(slowLoading).toHaveCount(0);
    const slowImage = slowPreview.locator("img");
    await expect.poll(() => imageNonBlackRatio(slowImage)).toBeGreaterThan(0.02);
    const slowBoxAfterRelease = await slowPreview.boundingBox();
    expect(slowBoxWhileLoading).not.toBeNull();
    expect(slowBoxAfterRelease).not.toBeNull();
    expect(Math.round(slowBoxWhileLoading!.width)).toBe(Math.round(slowBoxAfterRelease!.width));
    expect(Math.round(slowBoxWhileLoading!.height)).toBe(Math.round(slowBoxAfterRelease!.height));
    expect(brokenBox).not.toBeNull();
    expect(Math.round(brokenBox!.width)).toBe(Math.round(slowBoxAfterRelease!.width));
    expect(Math.round(brokenBox!.height)).toBe(Math.round(slowBoxAfterRelease!.height));

    const okImage = drawer.locator(".kc-card-library-item").filter({ hasText: "即时缩略图卡片" }).locator(".kc-card-library-preview img");
    await expect.poll(() => imageNonBlackRatio(okImage)).toBeGreaterThan(0.02);

    await page.screenshot({ path: testInfo.outputPath("mobile-cards-settled.png") });
  });

  test("tab switching and card save stay responsive while a slow thumbnail waits", async ({ page }) => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    await page.route("**/api/v1/card-library/card-thumbnails/slow.png", async (route) => {
      await slowGate;
      await route.fulfill({ body: visiblePng, contentType: "image/png" });
    });
    const cards = [
      { id: "card-mobile-slow", title: "慢速缩略图卡片", prompt: "等待慢速缩略图。", thumbUrl: "/api/v1/card-library/card-thumbnails/slow.png", hasImage: true },
    ];
    await page.route("**/api/v1/card-library/cards**", (route) => route.fulfill({
      json: { ok: true, data: { cards, total: cards.length, page: 1, limit: 18 } },
    }));

    await page.goto("/canvas");
    await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
    const drawer = page.getByRole("dialog", { name: "资源库" });
    const slowCard = drawer.locator(".kc-card-library-item").filter({ hasText: "慢速缩略图卡片" });
    await expect(slowCard).toBeVisible();

    // 慢速图片等待期间，收藏按钮仍然可用、可点击并进入保存中状态。
    const save = slowCard.getByRole("button", { name: "收藏卡片 慢速缩略图卡片" });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(save).toBeDisabled();

    // 切换标签页再回来，卡片仍然可见、可交互。
    await drawer.getByRole("tab", { name: "资产库" }).click();
    await drawer.getByRole("tab", { name: "卡片库" }).click();
    await expect(slowCard).toBeVisible();

    releaseSlow();
    await expect(slowCard.getByLabel("慢速缩略图卡片 已在资产库")).toBeVisible();
    await expect.poll(() => imageNonBlackRatio(slowCard.locator(".kc-card-library-preview img"))).toBeGreaterThan(0.02);
  });
});

test.describe("mobile canvas media loading", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
    await page.route("**/api/v1/model-catalog?*", (route) => route.fulfill({
      json: {
        ok: true,
        data: {
          version: "mobile-media-catalog",
          capabilityVersion: "mobile-media-capability",
          pricingVersion: "mobile-media-pricing",
          fetchedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          quoteAvailable: false,
          models: [],
        },
      },
    }));
  });

  test("image nodes keep fixed geometry and stay interactive while media decodes", async ({ page, context }, testInfo) => {
    const slowId = "mobile-slow-image";
    const brokenId = "mobile-broken-image";
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let slowReads = 0;
    let brokenReads = 0;

    await seedServerMediaProject(page, [
      { id: "mobile-slow-node", mediaId: slowId, name: "slow-mobile.png", width: 128, height: 128 },
      { id: "mobile-broken-node", mediaId: brokenId, name: "broken-mobile.png", width: 128, height: 128 },
    ]);
    await page.route(`**/api/v1/media/${slowId}/content`, async (route) => {
      slowReads += 1;
      await slowGate;
      await route.fulfill({ body: visiblePng, contentType: "image/png" });
    });
    await page.route(`**/api/v1/media/${brokenId}/content`, (route) => {
      brokenReads += 1;
      return route.fulfill({ status: 404, body: "not found" });
    });

    await page.goto("/canvas");
    await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 6_000 });
    const slowImage = page.locator('img[alt="slow-mobile.png"]');
    const brokenImage = page.locator('img[alt="broken-mobile.png"]');
    const slowNode = page.locator(".react-flow__node-kachang").filter({ has: slowImage });
    const brokenNode = page.locator(".react-flow__node-kachang").filter({ has: brokenImage });

    await expect(slowNode.getByText("结果已生成，正在载入")).toBeVisible();
    await expect.poll(() => slowReads).toBeGreaterThan(0);
    await expect(brokenNode.getByText("结果加载失败")).toBeVisible();
    await expect.poll(() => brokenReads).toBeGreaterThan(0);
    expect(await brokenImage.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(0);

    const slowBoxWhileLoading = await slowNode.boundingBox();
    await page.waitForTimeout(400);
    const slowBoxWhileLoadingAgain = await slowNode.boundingBox();
    expect(slowBoxWhileLoading).not.toBeNull();
    expect(slowBoxWhileLoadingAgain).not.toBeNull();
    expect(Math.round(slowBoxWhileLoading!.width)).toBe(Math.round(slowBoxWhileLoadingAgain!.width));
    expect(Math.round(slowBoxWhileLoading!.height)).toBe(Math.round(slowBoxWhileLoadingAgain!.height));
    expect(await slowNode.locator(".kc-media-result-state").count()).toBe(1);

    // 图片等待期间两指平移/缩放仍然即时生效。
    const client = await context.newCDPSession(page);
    const flow = page.locator(".react-flow__pane");
    const bounds = await flow.boundingBox();
    expect(bounds).not.toBeNull();
    const readViewport = () => page.locator(".react-flow__viewport").evaluate((element) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
    });
    const readNodeFlowSize = async (node: Locator) => {
      const box = await node.boundingBox();
      const viewport = await readViewport();
      return { width: box!.width / viewport.zoom, height: box!.height / viewport.zoom };
    };
    const slowFlowWhileLoading = await readNodeFlowSize(slowNode);
    const viewportBeforePan = await readViewport();
    const center = { x: bounds!.x + bounds!.width * 0.5, y: bounds!.y + bounds!.height * 0.72 };
    await dispatchGesture(client, [
      [touch(1, center.x - 42, center.y), touch(2, center.x + 42, center.y)],
      [touch(1, center.x - 92, center.y), touch(2, center.x + 92, center.y)],
    ]);
    await expect.poll(readViewport).not.toEqual(viewportBeforePan);

    await page.screenshot({ path: testInfo.outputPath("mobile-canvas-loading-during-pan.png") });

    releaseSlow();
    await expect.poll(() => imageNonBlackRatio(slowImage)).toBeGreaterThan(0.02);
    const slowFlowAfter = await readNodeFlowSize(slowNode);
    expect(Math.round(slowFlowAfter.width)).toBe(Math.round(slowFlowWhileLoading.width));
    expect(Math.round(slowFlowAfter.height)).toBe(Math.round(slowFlowWhileLoading.height));

    await page.screenshot({ path: testInfo.outputPath("mobile-canvas-settled.png") });
  });
});

test.describe("tablet canvas and card media loading", () => {
  test.use({ viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

  test("card thumbnails and canvas images keep fixed geometry at 768x1024", async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.clear());
    await mockAuthenticatedBackgroundApis(page);
    await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: session } }));
    await page.route("**/api/v1/wallet", (route) => route.fulfill({
      json: {
        ok: true,
        data: {
          credits: 0, creditsPermanent: 0, dailyCredits: 0, creditGrantMode: "bundle", dailyCreditsNote: "",
          membership: { tier: "free", until: null, active: false, genDiscount: null }, lifetimeCreditsSpent: 0,
        },
      },
    }));
    await page.route("**/api/v1/generation-jobs?*", (route) => route.fulfill({ json: { ok: true, data: [] } }));
    await page.route("**/api/v1/model-catalog?*", (route) => route.fulfill({
      json: {
        ok: true,
        data: {
          version: "tablet-media-catalog", capabilityVersion: "tablet-media-capability", pricingVersion: "tablet-media-pricing",
          fetchedAt: "2026-07-22T00:00:00.000Z", expiresAt: "2099-08-22T00:00:00.000Z", quoteAvailable: false, models: [],
        },
      },
    }));
    await page.route("**/api/v1/card-library/groups", (route) => route.fulfill({ json: { ok: true, data: { groups: [] } } }));

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    await page.route("**/api/v1/card-library/card-thumbnails/slow.png", async (route) => {
      await slowGate;
      await route.fulfill({ body: visiblePng, contentType: "image/png" });
    });
    await page.route("**/api/v1/card-library/card-thumbnails/broken.png", (route) => route.fulfill({ status: 404, body: "not found" }));
    const cards = [
      { id: "card-tablet-slow", title: "平板慢速卡", prompt: "等待解码。", thumbUrl: "/api/v1/card-library/card-thumbnails/slow.png", hasImage: true },
      { id: "card-tablet-broken", title: "平板失效卡", prompt: "不可达。", thumbUrl: "/api/v1/card-library/card-thumbnails/broken.png", hasImage: true },
    ];
    await page.route("**/api/v1/card-library/cards**", (route) => route.fulfill({
      json: { ok: true, data: { cards, total: cards.length, page: 1, limit: 18 } },
    }));

    await seedServerMediaProject(page, [
      { id: "tablet-slow-node", mediaId: "tablet-slow-image", name: "tablet-slow.png", width: 128, height: 128 },
    ]);
    await page.route("**/api/v1/media/tablet-slow-image/content", async (route) => {
      await slowGate;
      await route.fulfill({ body: visiblePng, contentType: "image/png" });
    });

    await page.goto("/canvas");
    await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 6_000 });
    const slowNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="image"])');
    await expect(slowNode.getByText("结果已生成，正在载入")).toBeVisible();
    const nodeBoxWhileLoading = await slowNode.boundingBox();

    await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
    const drawer = page.getByRole("dialog", { name: "资源库" });
    await expect(drawer).toBeVisible();
    const slowPreview = drawer.locator(".kc-card-library-item").filter({ hasText: "平板慢速卡" }).locator(".kc-card-library-preview");
    await expect(slowPreview.getByLabel("平板慢速卡 缩略图加载中")).toBeVisible();
    const brokenPreview = drawer.locator(".kc-card-library-item").filter({ hasText: "平板失效卡" }).locator(".kc-card-library-preview");
    await expect(brokenPreview.getByLabel("平板失效卡 缩略图不可用")).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath("tablet-media-loading.png") });

    releaseSlow();
    await expect.poll(() => imageNonBlackRatio(slowPreview.locator("img"))).toBeGreaterThan(0.02);
    const nodeBoxAfter = await slowNode.boundingBox();
    expect(nodeBoxWhileLoading).not.toBeNull();
    expect(nodeBoxAfter).not.toBeNull();
    expect(Math.round(nodeBoxWhileLoading!.width)).toBe(Math.round(nodeBoxAfter!.width));
    expect(Math.round(nodeBoxWhileLoading!.height)).toBe(Math.round(nodeBoxAfter!.height));

    await page.screenshot({ path: testInfo.outputPath("tablet-media-settled.png") });
  });
});

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
    let nonBlackPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 0 && (pixels[index] > 8 || pixels[index + 1] > 8 || pixels[index + 2] > 8)) nonBlackPixels += 1;
    }
    return nonBlackPixels / (canvas.width * canvas.height);
  });
}

type TouchPoint = { id: number; x: number; y: number; radiusX: number; radiusY: number; force: number };

function touch(id: number, x: number, y: number): TouchPoint {
  return { id, x, y, radiusX: 4, radiusY: 4, force: 0.5 };
}

async function dispatchGesture(client: CDPSession, keyframes: TouchPoint[][]) {
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: keyframes[0] });
  for (let index = 1; index < keyframes.length; index += 1) {
    await moveTouches(client, keyframes[index - 1], keyframes[index]);
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function moveTouches(client: CDPSession, from: TouchPoint[], to: TouchPoint[]) {
  for (let step = 1; step <= 8; step += 1) {
    const progress = step / 8;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: from.map((point, pointIndex) => ({
        ...point,
        x: point.x + (to[pointIndex].x - point.x) * progress,
        y: point.y + (to[pointIndex].y - point.y) * progress,
      })),
    });
  }
}

async function seedServerMediaProject(
  page: Page,
  nodes: Array<{ id: string; mediaId: string; name: string; width: number; height: number }>,
) {
  const now = Date.now();
  const projectId = "mobile-media-project";
  const project = {
    schemaVersion: 1,
    id: projectId,
    name: "Mobile media loading",
    nodes: nodes.map((node) => ({
      id: node.id,
      type: "kachang",
      position: { x: 120 + nodes.indexOf(node) * 260, y: 180 },
      width: 360,
      height: 360,
      selected: false,
      data: {
        kind: "image",
        body: "",
        accent: "blue",
        status: "success",
        progress: null,
        media: {
          id: node.mediaId,
          name: node.name,
          mimeType: "image/png",
          size: visiblePng.length,
          source: "server",
          serverId: node.mediaId,
          width: node.width,
          height: node.height,
          durationMs: null,
        },
        directorCapture: null,
        config: null,
        generation: {
          modelId: null,
          parameters: {},
          maxOutputTokens: null,
          referenceMode: "auto",
          referenceNodeIds: [],
          jobId: null,
          jobVersion: null,
          jobCreatedAt: null,
          jobStatus: null,
          error: null,
        },
        createdAt: now,
        updatedAt: now,
      },
    })),
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: now,
    updatedAt: now,
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
