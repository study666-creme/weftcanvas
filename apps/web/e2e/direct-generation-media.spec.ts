import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";

// 独立生图/视频页的结果媒体必须以原子方式出现：慢速/失效的服务端媒体在完整
// decode 前只能看到固定尺寸占位，不允许逐块显示、黑框或浏览器破图图标；刷新后
// 按 job id 恢复同一任务且不产生重复 POST。
const visiblePng = readFileSync(new URL("../src/assets/resource-library-mark.png", import.meta.url));
const generatedVideoFixture = readFileSync(new URL("./video-frame.mp4", import.meta.url));

const now = new Date();
const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();

function session() {
  return {
    user: {
      id: "07d3b269-6bc3-4dbb-b67f-28664c787f00",
      email: "creator@example.com",
      displayName: "创作者",
      createdAt: now.toISOString(),
    },
    expiresAt,
  };
}

function imageModel() {
  return {
    id: "home-image",
    label: "首页图片模型",
    description: "快速生成静帧画面",
    modality: "image",
    operation: "generate",
    order: 0,
    input: { textRequired: true, images: { min: 0, max: 2, multiple: true } },
    output: { type: "image", minCount: 1, maxCount: 1 },
    parameters: [
      { name: "prompt", label: "提示词", type: "string", required: true, mutuallyExclusiveWith: [] },
    ],
    pricing: {
      mode: "fixed",
      unit: "image",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: 2_000_000,
      baseYuanMicros: 20_000,
      tiers: [],
    },
  };
}

function videoModel() {
  return {
    id: "home-video",
    label: "首页视频模型",
    description: "快速生成动态镜头",
    modality: "video",
    operation: "generate",
    order: 0,
    input: { textRequired: true, images: { min: 0, max: 2, multiple: true } },
    output: { type: "video", minCount: 1, maxCount: 1 },
    parameters: [
      { name: "prompt", label: "提示词", type: "string", required: true, mutuallyExclusiveWith: [] },
    ],
    pricing: {
      mode: "fixed",
      unit: "second",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: 5_000_000,
      baseYuanMicros: 50_000,
      tiers: [],
    },
  };
}

function quote(modality: "image" | "video", request: Record<string, unknown>) {
  return {
    id: `quote-media-${modality}`,
    modelId: request.modelId,
    modelLabel: modality === "image" ? "首页图片模型" : "首页视频模型",
    modality,
    quantity: 1,
    normalizedParameters: request.parameters,
    creditMicros: modality === "image" ? 2_000_000 : 5_000_000,
    credits: modality === "image" ? "2" : "5",
    yuanMicros: modality === "image" ? 20_000 : 50_000,
    yuan: modality === "image" ? "0.02" : "0.05",
    estimated: false,
    pricingUnit: modality === "image" ? "image" : "second",
    catalogVersion: `catalog-media-${modality}`,
    capabilityVersion: `capability-media-${modality}`,
    pricingVersion: `pricing-media-${modality}`,
    expiresAt,
  };
}

function completedJob(request: Record<string, unknown>) {
  const modality = request.modality as "image" | "video";
  const createdAt = new Date().toISOString();
  const image = modality === "image";
  return {
    schemaVersion: 1,
    version: 1,
    id: image ? "job-media-image" : "job-media-video",
    projectId: request.projectId,
    nodeId: request.nodeId,
    modelId: request.modelId,
    modelLabel: image ? "首页图片模型" : "首页视频模型",
    modality,
    status: "completed",
    progress: 100,
    quote: quote(modality, request),
    artifacts: image ? [{
      id: "artifact-media-image",
      kind: "image",
      mediaId: "media-image",
      name: "result.png",
      mimeType: "image/png",
      size: visiblePng.byteLength,
      width: 128,
      height: 128,
      createdAt,
    }] : [{
      id: "artifact-media-video",
      kind: "video",
      mediaId: "media-video",
      name: "result.mp4",
      mimeType: "video/mp4",
      size: generatedVideoFixture.byteLength,
      duration: 4.086009,
      createdAt,
    }],
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
  };
}

type MediaMode = "ok" | "slow" | "broken";

async function mockDirectMediaApis(page: Page, options: { image?: MediaMode; video?: MediaMode } = {}) {
  await mockAuthenticatedBackgroundApis(page);
  const imageMode: { value: MediaMode } = { value: options.image ?? "ok" };
  const videoMode: { value: MediaMode } = { value: options.video ?? "ok" };
  let releaseSlowImage: (() => void) | null = null;
  const slowImageGate = new Promise<void>((resolve) => { releaseSlowImage = resolve; });
  let releaseSlowVideo: (() => void) | null = null;
  const slowVideoGate = new Promise<void>((resolve) => { releaseSlowVideo = resolve; });
  let imageReads = 0;
  let videoReads = 0;
  let posts = 0;
  const jobs: Record<string, unknown>[] = [];

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: session() } }));
  await page.route("**/api/v1/auth/login", (route) => route.fulfill({ json: { ok: true, data: session() } }));
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
  await page.route("**/api/v1/model-catalog**", (route) => {
    const requestedModality = new URL(route.request().url()).searchParams.get("modality");
    const models = requestedModality === "image"
      ? [imageModel()]
      : requestedModality === "video"
        ? [videoModel()]
        : requestedModality === "text" || requestedModality === "audio"
          ? []
          : [imageModel(), videoModel()];
    return route.fulfill({
      json: {
        ok: true,
        data: {
          version: `catalog-media-${requestedModality ?? "all"}`,
          capabilityVersion: `capability-media-${requestedModality ?? "all"}`,
          pricingVersion: `pricing-media-${requestedModality ?? "all"}`,
          fetchedAt: now.toISOString(),
          expiresAt,
          quoteAvailable: models.length > 0,
          models,
        },
      },
    });
  });
  await page.route("**/api/v1/generation-quotes", (route) => {
    const request = route.request().postDataJSON();
    return route.fulfill({
      json: { ok: true, data: quote(request.modality as "image" | "video", request) },
    });
  });
  await page.route("**/api/v1/generation-jobs*", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { ok: true, data: jobs } });
    posts += 1;
    const request = route.request().postDataJSON();
    const job = completedJob(request);
    jobs.push(job);
    return route.fulfill({ status: 202, json: { ok: true, data: job } });
  });
  // 单任务轮询/SSE 断连后的 poll 走 `/:id`，与列表查询不同，需单独拦截，避免漏到本地代理。
  await page.route("**/api/v1/generation-jobs/*", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { ok: true, data: null } });
    return route.fulfill({ status: 404, json: { ok: false, error: { code: "JOB_NOT_FOUND", message: "not found" } } });
  });
  await page.route("**/api/v1/media/media-image/content*", async (route) => {
    imageReads += 1;
    if (imageMode.value === "slow") await slowImageGate;
    if (imageMode.value === "broken") return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ body: visiblePng, contentType: "image/png" });
  });
  await page.route("**/api/v1/media/media-video/content*", async (route) => {
    videoReads += 1;
    if (videoMode.value === "slow") await slowVideoGate;
    if (videoMode.value === "broken") return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ body: generatedVideoFixture, contentType: "video/mp4" });
  });
  return {
    readImageReads: () => imageReads,
    readVideoReads: () => videoReads,
    readPosts: () => posts,
    setImageMode: (mode: MediaMode) => { imageMode.value = mode; },
    setVideoMode: (mode: MediaMode) => { videoMode.value = mode; },
    releaseSlowImage: () => releaseSlowImage?.(),
    releaseSlowVideo: () => releaseSlowVideo?.(),
  };
}

async function submitImage(page: Page) {
  const studio = page.locator("[data-direct-generation]");
  await studio.locator("[data-direct-prompt]").fill("一座被雨水照亮的未来城市");
  await expect(studio).toContainText("2 积分");
  const submit = studio.locator(".kc-direct-submit");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(studio.locator("img[alt='生成的图片结果']")).toHaveCount(0);
}

async function hasCachedMedia(page: Page, mediaId: string) {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("kachang-canvas-media", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const request = database.transaction("media", "readonly").objectStore("media").get(id);
        request.onsuccess = () => resolve(Boolean(request.result?.blob));
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, mediaId);
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

test("direct image result swaps atomically after decode and keeps fixed geometry", async ({ page }, testInfo) => {
  const mocks = await mockDirectMediaApis(page, { image: "slow" });
  await page.goto("/generate/image");

  await submitImage(page);
  const studio = page.locator("[data-direct-generation]");
  const tile = studio.locator(".kc-direct-result-tile");

  // 慢速服务端媒体期间：没有 img、有固定尺寸占位、画布/表单保持可交互。
  await expect(tile.getByRole("status")).toBeVisible();
  await expect(tile.getByText("正在读取结果")).toBeVisible();
  await expect.poll(mocks.readImageReads).toBeGreaterThan(0);
  expect(await tile.locator("img").count()).toBe(0);

  const prompt = studio.locator("[data-direct-prompt]");
  await expect(prompt).toBeEnabled();
  await prompt.fill("解码期间仍然可以继续编辑提示词");
  await expect(prompt).toHaveValue("解码期间仍然可以继续编辑提示词");

  const boxWhileLoading = await tile.boundingBox();
  await page.waitForTimeout(350);
  const boxWhileLoadingAgain = await tile.boundingBox();
  expect(boxWhileLoading).not.toBeNull();
  expect(boxWhileLoadingAgain).not.toBeNull();
  expect(Math.round(boxWhileLoading!.width)).toBe(Math.round(boxWhileLoadingAgain!.width));
  expect(Math.round(boxWhileLoading!.height)).toBe(Math.round(boxWhileLoadingAgain!.height));

  await page.screenshot({ path: testInfo.outputPath("direct-image-loading-atomic.png") });

  mocks.releaseSlowImage();
  const image = tile.locator("img[alt='生成的图片结果']");
  await expect(image).toHaveCount(1);
  await expect.poll(() => imageNonBlackRatio(image)).toBeGreaterThan(0.02);
  await expect(tile.getByText("正在读取结果")).toHaveCount(0);
  // decode 后单次出现：等待后仍然只有一张。
  await page.waitForTimeout(400);
  await expect(image).toHaveCount(1);

  const boxAfter = await tile.boundingBox();
  expect(Math.round(boxAfter!.width)).toBe(Math.round(boxWhileLoading!.width));
  expect(Math.round(boxAfter!.height)).toBe(Math.round(boxWhileLoading!.height));
  await page.screenshot({ path: testInfo.outputPath("direct-image-atomic-settled.png") });
});

test("direct image result 404 shows a retryable error and recovers without a broken icon", async ({ page }, testInfo) => {
  const mocks = await mockDirectMediaApis(page, { image: "broken" });
  await page.goto("/generate/image");

  await submitImage(page);
  const studio = page.locator("[data-direct-generation]");
  const tile = studio.locator(".kc-direct-result-tile");

  await expect(tile.getByRole("alert")).toBeVisible();
  await expect(tile).toContainText("结果加载失败");
  expect(await tile.locator("img").count()).toBe(0);
  const errorBox = await tile.boundingBox();

  await page.screenshot({ path: testInfo.outputPath("direct-image-error.png") });

  mocks.setImageMode("ok");
  await tile.getByRole("button", { name: "重新加载" }).click();
  const image = tile.locator("img[alt='生成的图片结果']");
  await expect(image).toHaveCount(1);
  await expect.poll(() => imageNonBlackRatio(image)).toBeGreaterThan(0.02);
  const recoveredBox = await tile.boundingBox();
  expect(Math.round(recoveredBox!.width)).toBe(Math.round(errorBox!.width));
  expect(Math.round(recoveredBox!.height)).toBe(Math.round(errorBox!.height));
  await page.screenshot({ path: testInfo.outputPath("direct-image-recovered.png") });
});

test("direct video result keeps a fixed-ratio placeholder until the first frame", async ({ page }, testInfo) => {
  const mocks = await mockDirectMediaApis(page, { video: "slow" });
  await page.goto("/generate/video");

  const studio = page.locator("[data-direct-generation]");
  await studio.locator("[data-direct-prompt]").fill("把想法变成一段有镜头感的动态片段");
  await expect(studio).toContainText("5 积分");
  const submit = studio.locator(".kc-direct-submit");
  await expect(submit).toBeEnabled();
  await submit.click();

  const frame = studio.locator(".kc-direct-result-media--video");
  await expect(frame.getByRole("status")).toBeVisible();
  await expect(frame.getByText("正在读取结果")).toBeVisible();
  await expect.poll(mocks.readVideoReads).toBeGreaterThan(0);

  const video = frame.locator("video");
  await expect(video).toHaveCount(1);
  await expect(frame).not.toHaveClass(/is-ready/);

  const box = await frame.boundingBox();
  expect(box).not.toBeNull();
  // 结果卡片已是正方形（aspect-ratio: 1），视频首帧占位随卡片保持正方形。
  const ratio = box!.width / box!.height;
  expect(Math.abs(ratio - 1)).toBeLessThan(0.05);

  await page.screenshot({ path: testInfo.outputPath("direct-video-loading-atomic.png") });

  // 页面隐藏/移动端解码暂停不能被误判为失败，恢复可见后继续加载。
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(frame.getByText("正在读取结果")).toBeVisible();
  await expect(frame.getByRole("alert")).toHaveCount(0);

  mocks.releaseSlowVideo();
  await expect(frame).toHaveClass(/is-ready/, { timeout: 10_000 });
  await expect(frame.getByText("正在读取结果")).toHaveCount(0);
  await expect.poll(() => video.evaluate((element) => element.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((element) => element.videoWidth)).toBeGreaterThan(0);
  const settledBox = await frame.boundingBox();
  expect(Math.round(settledBox!.width)).toBe(Math.round(box!.width));
  expect(Math.round(settledBox!.height)).toBe(Math.round(box!.height));
  await page.screenshot({ path: testInfo.outputPath("direct-video-atomic-settled.png") });
});

test("direct video result 404 shows a retryable error and recovers", async ({ page }) => {
  const mocks = await mockDirectMediaApis(page, { video: "broken" });
  await page.goto("/generate/video");

  const studio = page.locator("[data-direct-generation]");
  await studio.locator("[data-direct-prompt]").fill("一段缓慢推近的镜头");
  await expect(studio).toContainText("5 积分");
  const submit = studio.locator(".kc-direct-submit");
  await expect(submit).toBeEnabled();
  await submit.click();

  const frame = studio.locator(".kc-direct-result-media--video");
  await expect(frame.getByRole("alert")).toBeVisible();
  await expect(frame).toContainText("结果加载失败");

  mocks.setVideoMode("ok");
  await frame.getByRole("button", { name: "重新加载" }).click();
  await expect(frame).toHaveClass(/is-ready/, { timeout: 10_000 });
  await expect(frame.getByText("结果加载失败")).toHaveCount(0);
});

test("direct studio refresh restores the completed job without a duplicate POST", async ({ page }) => {
  const mocks = await mockDirectMediaApis(page);
  await page.goto("/generate/image");

  await submitImage(page);
  const studio = page.locator("[data-direct-generation]");
  const image = studio.locator("img[alt='生成的图片结果']");
  await expect(image).toHaveCount(1);
  await expect.poll(() => imageNonBlackRatio(image)).toBeGreaterThan(0.02);
  await expect.poll(() => mocks.readImageReads()).toBeGreaterThan(0);

  const postsBefore = mocks.readPosts();
  const readsBefore = mocks.readImageReads();
  // 产物以异步方式落 IndexedDB；先缓存再刷新，验证恢复走本地缓存（blob:）且不重复拉原图。
  await expect.poll(() => hasCachedMedia(page, "media-image")).toBe(true);
  await page.reload();
  await expect(page.locator("[data-direct-generation] img[alt='生成的图片结果']")).toHaveAttribute("src", /^blob:/);
  expect(mocks.readPosts()).toBe(postsBefore);
  expect(mocks.readImageReads()).toBe(readsBefore);
});

test("mobile direct image result stays atomic and inside the viewport while a slow result decodes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mocks = await mockDirectMediaApis(page, { image: "slow" });
  await page.goto("/generate/image");

  await submitImage(page);
  const studio = page.locator("[data-direct-generation]");
  const tile = studio.locator(".kc-direct-result-tile");
  await expect(tile.getByText("正在读取结果")).toBeVisible();
  await expect.poll(mocks.readImageReads).toBeGreaterThan(0);
  expect(await tile.locator("img").count()).toBe(0);

  const documentBefore = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(documentBefore.scrollWidth).toBe(documentBefore.width);

  mocks.releaseSlowImage();
  const image = tile.locator("img[alt='生成的图片结果']");
  await expect(image).toHaveCount(1);
  await expect.poll(() => imageNonBlackRatio(image)).toBeGreaterThan(0.02);
  await page.waitForTimeout(300);
  await expect(image).toHaveCount(1);
  const documentAfter = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(documentAfter.scrollWidth).toBe(documentAfter.width);
  await page.screenshot({ path: testInfo.outputPath("mobile-direct-image-atomic.png") });
});
