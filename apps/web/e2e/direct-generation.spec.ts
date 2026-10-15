import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";
import { skipOnboardingTour } from "./onboarding.fixture";
import { expect, test } from "./zero-cost-test";

const now = new Date();
const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
const visibleGeneratedImage = readFileSync(
  new URL("../src/assets/resource-library-mark.png", import.meta.url),
);
const generatedVideoFixture = readFileSync(new URL("./video-frame.mp4", import.meta.url));
// 使用真实可解码的音频夹具，覆盖浏览器完整媒体加载路径。
const generatedAudioFixture = readFileSync(new URL("./audio-tone.mp3", import.meta.url));

// 检查首帧像素，避免播放控件可见却仍渲染为黑帧的假阳性。
async function videoFrameNonBlackRatio(video: Locator) {
  return video.evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) throw new Error("Expected a video element");
    const { videoWidth: width, videoHeight: height } = element;
    if (width === 0 || height === 0) return 0;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable");
    context.drawImage(element, 0, 0, width, height);

    const pixels = context.getImageData(0, 0, width, height).data;
    let nonBlackPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (
        pixels[index + 3] > 0 &&
        (pixels[index] > 8 || pixels[index + 1] > 8 || pixels[index + 2] > 8)
      ) {
        nonBlackPixels += 1;
      }
    }
    return nonBlackPixels / (width * height);
  });
}

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

function model(modality: "image" | "video" | "audio") {
  const labels = {
    image: { id: "home-image", label: "首页图片模型", description: "快速生成静帧画面" },
    video: { id: "home-video", label: "首页视频模型", description: "快速生成动态镜头" },
    audio: { id: "home-audio", label: "首页音频模型", description: "快速生成音乐或语音" },
  }[modality];
  return {
    id: labels.id,
    label: labels.label,
    description: labels.description,
    modality,
    operation: "generate",
    order: 0,
    input:
      modality === "image"
        ? { textRequired: true, images: { min: 0, max: 2, multiple: true } }
        : modality === "video"
          ? {
              textRequired: true,
              images: { min: 0, max: 2, multiple: true },
              videos: { min: 0, max: 1, multiple: false },
              audios: { min: 0, max: 1, multiple: false },
            }
          : { textRequired: true },
    output: { type: modality, minCount: 1, maxCount: 1 },
    parameters: [
      {
        name: "prompt",
        label: "提示词",
        type: "string",
        required: true,
        mutuallyExclusiveWith: [],
      },
      ...(modality === "image"
        ? [
            {
              name: "quality",
              label: "画质",
              type: "string",
              required: false,
              default: "2k",
              options: ["1k", "2k"],
              mutuallyExclusiveWith: [],
            },
          ]
        : modality === "video"
          ? [
              {
                name: "duration",
                label: "时长",
                type: "number",
                required: false,
                default: 5,
                min: 1,
                max: 10,
                step: 1,
                mutuallyExclusiveWith: [],
              },
              {
                name: "referenceImages",
                label: "参考图片链接",
                type: "array",
                required: false,
                items: { type: "string", format: "uri-or-data-image" },
                mutuallyExclusiveWith: [],
              },
            ]
          : []),
    ],
    pricing: {
      mode: "fixed",
      unit: modality === "image" ? "image" : modality === "video" ? "second" : "request",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros:
        modality === "image" ? 2_000_000 : modality === "video" ? 5_000_000 : 1_500_000,
      baseYuanMicros: modality === "image" ? 20_000 : modality === "video" ? 50_000 : 15_000,
      tiers: [],
    },
  };
}

function omniVideoModel() {
  return {
    ...model("video"),
    id: "gemini-omni-flash",
    label: "Gemini Omni Flash",
    input: {
      textRequired: true,
      images: { min: 0, max: 1, multiple: false },
      videos: { min: 0, max: 1, multiple: false },
      referenceMedia: {
        images: { min: 0, max: 1, multiple: false, role: "frame" },
        styleImages: { min: 0, max: 4, multiple: true },
        elementImages: { min: 0, max: 3, multiple: true },
        videos: { min: 0, max: 1, multiple: false },
        maxTotalItems: 4,
      },
    },
  };
}

async function mockDirectApis(
  page: Page,
  catalogOverrides: Partial<Record<"image" | "video" | "audio", ReturnType<typeof model>[]>> = {},
  options: { authDelayMs?: number } = {},
) {
  await mockAuthenticatedBackgroundApis(page);
  const labelFor = (modality: string) =>
    modality === "image" ? "首页图片模型" : modality === "video" ? "首页视频模型" : "首页音频模型";
  const priceFor = (modality: string) =>
    modality === "image"
      ? { creditMicros: 2_000_000, credits: "2", yuanMicros: 20_000, yuan: "0.02", unit: "image" }
      : modality === "video"
        ? {
            creditMicros: 5_000_000,
            credits: "5",
            yuanMicros: 50_000,
            yuan: "0.05",
            unit: "second",
          }
        : {
            creditMicros: 1_500_000,
            credits: "1.5",
            yuanMicros: 15_000,
            yuan: "0.015",
            unit: "request",
          };
  let authHits = 0;
  let generatedImageAvailable = true;
  let generatedImageReads = 0;
  let quoteRequest: Record<string, unknown> | null = null;
  const mediaUploadRequests: Record<string, unknown>[] = [];
  const uploadedMediaIds = {
    image: "11111111-1111-4111-8111-111111111111",
    video: "22222222-2222-4222-8222-222222222222",
    audio: "33333333-3333-4333-8333-333333333333",
  } as const;
  type UploadKind = keyof typeof uploadedMediaIds;
  type MediaUploadRequest = Record<string, unknown> & {
    kind: UploadKind;
    name: string;
    mimeType: string;
    size: number;
  };
  const mediaUploads = new Map<UploadKind, MediaUploadRequest>();
  await page.route(/\/api\/v1\/auth\/session(?:\?.*)?$/, async (route) => {
    authHits += 1;
    if (options.authDelayMs)
      await new Promise((resolve) => setTimeout(resolve, options.authDelayMs));
    return route.fulfill({ json: { ok: true, data: session() } });
  });
  await page.route(/\/api\/v1\/wallet(?:\?.*)?$/, (route) =>
    route.fulfill({
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
    }),
  );
  await page.route("**/api/v1/auth/login", (route) =>
    route.fulfill({ json: { ok: true, data: session() } }),
  );
  await page.route("**/api/v1/model-catalog**", (route) => {
    const requestedModality = new URL(route.request().url()).searchParams.get("modality");
    const imageModels = catalogOverrides.image ?? [model("image")];
    const videoModels = catalogOverrides.video ?? [model("video")];
    const audioModels = catalogOverrides.audio ?? [model("audio")];
    const models =
      requestedModality === "image"
        ? imageModels
        : requestedModality === "video"
          ? videoModels
          : requestedModality === "audio"
            ? audioModels
            : requestedModality === "text"
              ? []
              : [...imageModels, ...videoModels, ...audioModels];
    return route.fulfill({
      json: {
        ok: true,
        data: {
          version: `home-${requestedModality ?? "all"}-catalog`,
          capabilityVersion: `home-${requestedModality ?? "all"}-capability`,
          pricingVersion: `home-${requestedModality ?? "all"}-pricing`,
          fetchedAt: now.toISOString(),
          expiresAt,
          quoteAvailable: models.length > 0,
          models,
        },
      },
    });
  });

  const uploadedMedia = (request: MediaUploadRequest, status: "pending" | "ready") => ({
    id: uploadedMediaIds[request.kind],
    kind: request.kind,
    name: request.name,
    mimeType: request.mimeType,
    size: request.size,
    sha256: status === "ready" ? "a".repeat(64) : null,
    width:
      status === "ready" && request.kind !== "audio" ? (request.kind === "image" ? 1 : 1280) : null,
    height:
      status === "ready" && request.kind !== "audio" ? (request.kind === "image" ? 1 : 720) : null,
    durationMs: status === "ready" && request.kind !== "image" ? 5_000 : null,
    status,
    error: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  await page.route("**/api/v1/media/uploads", async (route) => {
    const request = route.request().postDataJSON() as MediaUploadRequest;
    if (!(request.kind in uploadedMediaIds)) {
      await route.fulfill({
        status: 400,
        json: { ok: false, error: { message: "Unsupported test media kind" } },
      });
      return;
    }
    mediaUploadRequests.push(request);
    mediaUploads.set(request.kind, request);
    const uploadedMediaId = uploadedMediaIds[request.kind];
    await route.fulfill({
      json: {
        ok: true,
        data: {
          media: uploadedMedia(request, "pending"),
          upload: {
            method: "PUT",
            url: `/api/v1/media/${uploadedMediaId}/content`,
            headers: { "Content-Type": request.mimeType },
            expiresAt,
            completeUrl: null,
          },
        },
      },
    });
  });
  for (const kind of ["image", "video", "audio"] as const) {
    await page.route(`**/api/v1/media/${uploadedMediaIds[kind]}/content`, async (route) => {
      if (route.request().method() !== "PUT") return route.fulfill({ status: 405 });
      const request = mediaUploads.get(kind);
      if (!request) return route.fulfill({ status: 404 });
      await route.fulfill({ json: { ok: true, data: uploadedMedia(request, "ready") } });
    });
  }

  await page.route("**/api/v1/generation-quotes", async (route) => {
    const request = route.request().postDataJSON();
    quoteRequest = request;
    const price = priceFor(request.modality);
    await route.fulfill({
      json: {
        ok: true,
        data: {
          id: `quote-${request.modelId}`,
          modelId: request.modelId,
          modelLabel: labelFor(request.modality),
          modality: request.modality,
          quantity: 1,
          normalizedParameters: request.parameters,
          creditMicros: price.creditMicros,
          credits: price.credits,
          yuanMicros: price.yuanMicros,
          yuan: price.yuan,
          estimated: false,
          pricingUnit: price.unit,
          catalogVersion: `home-${request.modality}-catalog`,
          capabilityVersion: `home-${request.modality}-capability`,
          pricingVersion: `home-${request.modality}-pricing`,
          expiresAt,
        },
      },
    });
  });

  let submission: Record<string, unknown> | null = null;
  await page.route("**/api/v1/generation-jobs**", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { ok: true, data: [] } });
    submission = route.request().postDataJSON();
    const request = submission;
    const createdAt = new Date().toISOString();
    const price = priceFor(request.modality);
    const artifact =
      request.modality === "image"
        ? {
            name: "result.png",
            mimeType: "image/png",
            size: visibleGeneratedImage.byteLength,
            extra: { width: 128, height: 128 },
          }
        : request.modality === "video"
          ? {
              name: "result.mp4",
              mimeType: "video/mp4",
              size: generatedVideoFixture.byteLength,
              extra: { duration: 4.086009 },
            }
          : {
              name: "result.mp3",
              mimeType: "audio/mpeg",
              size: generatedAudioFixture.byteLength,
              extra: { duration: 1.5 },
            };
    const completed = {
      schemaVersion: 1,
      version: 1,
      id: `job-${request.modality}`,
      projectId: request.projectId,
      nodeId: request.nodeId,
      modelId: request.modelId,
      modelLabel: labelFor(request.modality),
      modality: request.modality,
      parameters: request.parameters,
      status: "completed",
      progress: 100,
      quote: {
        id: `quote-${request.modelId}`,
        modelId: request.modelId,
        modelLabel: labelFor(request.modality),
        modality: request.modality,
        quantity: 1,
        normalizedParameters: request.parameters,
        creditMicros: price.creditMicros,
        credits: price.credits,
        yuanMicros: price.yuanMicros,
        yuan: price.yuan,
        estimated: false,
        pricingUnit: price.unit,
        catalogVersion: `home-${request.modality}-catalog`,
        capabilityVersion: `home-${request.modality}-capability`,
        pricingVersion: `home-${request.modality}-pricing`,
        expiresAt,
      },
      artifacts: [
        {
          id: `artifact-${request.modality}`,
          kind: request.modality,
          mediaId: `media-${request.modality}`,
          name: artifact.name,
          mimeType: artifact.mimeType,
          size: artifact.size,
          ...artifact.extra,
          createdAt,
        },
      ],
      error: null,
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      completedAt: createdAt,
    };
    await route.fulfill({ status: 202, json: { ok: true, data: completed } });
  });
  await page.route("**/api/v1/media/media-image/content*", (route) => {
    generatedImageReads += 1;
    return generatedImageAvailable
      ? route.fulfill({
          body: visibleGeneratedImage,
          contentType: "image/png",
        })
      : route.fulfill({ status: 503, body: "temporarily unavailable" });
  });
  await page.route("**/api/v1/media/media-video/content*", (route) =>
    route.fulfill({ body: generatedVideoFixture, contentType: "video/mp4" }),
  );
  await page.route("**/api/v1/media/media-audio/content*", (route) =>
    route.fulfill({ body: generatedAudioFixture, contentType: "audio/mpeg" }),
  );
  return {
    readSubmission: () => submission,
    readAuthHits: () => authHits,
    readQuoteRequest: () => quoteRequest,
    readMediaUploadRequest: () => mediaUploadRequests.at(-1) ?? null,
    readMediaUploadRequests: () => mediaUploadRequests,
    readGeneratedImageReads: () => generatedImageReads,
    disableGeneratedImage: () => {
      generatedImageAvailable = false;
    },
    uploadedMediaId: uploadedMediaIds.image,
    uploadedMediaIds,
  };
}

test("homepage keeps direct generation out of the entry page and exposes sticky generation links", async ({
  page,
}) => {
  await mockDirectApis(page);
  await skipOnboardingTour(page);
  await page.goto("/");

  const gate = page.locator(".wc-entry-gate");
  await expect(gate).toBeVisible();
  await expect(gate.locator("[data-direct-generation]")).toHaveCount(0);

  const nav = gate.locator(".wc-entry-nav");
  await expect(nav).toHaveCSS("position", "sticky");
  const imageLink = page.getByRole("link", { name: "图片生成" });
  const videoLink = page.getByRole("link", { name: "视频生成" });
  await expect(imageLink).toHaveAttribute("href", "/generate/image");
  await expect(videoLink).toHaveAttribute("href", "/generate/video");

  await imageLink.click();
  await expect(page).toHaveURL(/\/generate\/image$/);
  await expect(page.locator(".wc-direct-page")).toBeVisible();
  await expect(page.locator("[data-direct-generation]")).toHaveAttribute(
    "data-direct-modality",
    "image",
  );
});

test("image picker groups universal and banana models with English banana variants on mobile", async ({
  page,
}, testInfo) => {
  const imageModels = [
    { ...model("image"), id: "gpt-image-2-4k-Adobe", label: "全能模型2 · 4K Adobe", order: 20 },
    { ...model("image"), id: "nano-banana", label: "香蕉 · 标准 1K", order: 40 },
    { ...model("image"), id: "nano-banana-fast", label: "香蕉 · 极速 1K", order: 41 },
    { ...model("image"), id: "nano-banana-2-lite", label: "香蕉 · Lite 1K", order: 42 },
    { ...model("image"), id: "nano-banana-pro", label: "香蕉 · 专业 1K/2K/4K", order: 43 },
    { ...model("image"), id: "nano-banana-2", label: "香蕉 · 2代 1K/2K/4K", order: 44 },
  ];
  await mockDirectApis(page, { image: imageModels });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/generate/image");

  await page.getByRole("button", { name: "模型" }).click();
  const menu = page.locator(".wc-cat-select-menu");
  await expect(menu).toBeVisible();
  const tabs = menu.getByRole("tab");
  await expect(tabs).toHaveText(["香蕉", "全能模型2"]);
  await menu.getByRole("tab", { name: "香蕉" }).click();
  const options = menu.getByRole("option");
  await expect(options).toHaveCount(5);
  await expect(options).toContainText([
    "香蕉 · Standard 1K",
    "香蕉 · Fast 1K",
    "香蕉 · Lite 1K",
    "香蕉 · Pro 1K/2K/4K",
    "香蕉 · 2 1K/2K/4K",
  ]);
  await expect(menu).not.toContainText("香蕉 · 标准");
  await expect(menu).not.toContainText("香蕉 · 极速");
  await expect(menu).not.toContainText("香蕉 · 专业");
  await expect(menu).not.toContainText("香蕉 · 2代");
  await page.screenshot({
    path: testInfo.outputPath("direct-image-model-groups-mobile.png"),
    fullPage: false,
  });
});

test("model picker shows aggregated success rate and description per option", async ({
  page,
}, testInfo) => {
  const imageModels = [
    {
      ...model("image"),
      id: "nano-banana",
      label: "香蕉 · 标准 1K",
      description: "支持多档分辨率的高质量图像模型",
      health: { successRate: 0.92, sampleCount: 137, windowHours: 168 },
      order: 40,
    },
    {
      ...model("image"),
      id: "nano-banana-pro",
      label: "香蕉 · 专业 1K/2K/4K",
      description: "专业档，出图更稳",
      health: { successRate: 0.55, sampleCount: 20, windowHours: 168 },
      order: 41,
    },
    {
      ...model("image"),
      id: "nano-banana-2",
      label: "香蕉 · 2代 1K/2K/4K",
      description: "第二代香蕉模型",
      order: 42,
    },
  ];
  await mockDirectApis(page, { image: imageModels });
  await page.goto("/generate/image");

  await page.getByRole("button", { name: "模型" }).click();
  const menu = page.locator(".wc-cat-select-menu");
  await expect(menu).toBeVisible();
  const options = menu.getByRole("option");
  await expect(options).toHaveCount(3);

  // 有成功率数据：能量条 + 百分比 + 真实样本 tooltip。
  const first = options.nth(0);
  await expect(first.locator(".wc-cat-select-energy")).toBeVisible();
  await expect(first.locator(".wc-cat-select-energy")).toHaveText("92%");
  await expect(first.locator(".wc-cat-select-energy")).toHaveAttribute(
    "title",
    "近 7 天真实成功率 92%（137 次生成）",
  );
  await expect(first.locator(".wc-cat-select-energy")).toHaveClass(/is-high/);
  await expect(first.locator(".wc-cat-select-option-desc")).toHaveText(
    "支持多档分辨率的高质量图像模型",
  );
  // 低成功率标红。
  await expect(options.nth(1).locator(".wc-cat-select-energy")).toHaveClass(/is-low/);
  await expect(options.nth(1).locator(".wc-cat-select-energy")).toHaveText("55%");
  // 无数据模型不渲染能量条，但简介照常展示。
  await expect(options.nth(2).locator(".wc-cat-select-energy")).toHaveCount(0);
  await expect(options.nth(2).locator(".wc-cat-select-option-desc")).toHaveText("第二代香蕉模型");

  await page.screenshot({
    path: testInfo.outputPath("model-picker-energy-and-description.png"),
    fullPage: false,
  });
});

test("standalone image generation submits without canvas nodes and previews the result", async ({
  page,
}, testInfo) => {
  test.slow();
  const {
    readSubmission,
    readAuthHits,
    readQuoteRequest,
    readMediaUploadRequest,
    readGeneratedImageReads,
    disableGeneratedImage,
    uploadedMediaId,
  } = await mockDirectApis(page);
  await page.goto("/generate/image");
  await expect.poll(readAuthHits).toBeGreaterThan(0);
  const studio = page.locator("[data-direct-generation]");
  await expect(page.locator(".wc-direct-page")).toHaveAttribute("aria-label", "图片生成页面");
  await expect(studio).toHaveAttribute("data-direct-modality", "image");
  await expect(studio.getByRole("button", { name: "模型" })).toContainText("首页图片模型");
  await studio.locator("[data-direct-prompt]").fill("一座被雨水照亮的未来城市");
  await studio.locator("[data-direct-material-input='image']").setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(studio.locator(".wc-direct-material-item")).toContainText("已上传");
  await expect
    .poll(() => readQuoteRequest()?.inputs)
    .toEqual({ images: 1, styleImages: 0, elementImages: 0, videos: 0, audios: 0 });
  await expect(studio).toContainText("2 积分");
  const submit = studio.locator(".wc-direct-submit");
  await expect(submit).toBeVisible();
  await expect(submit).toBeEnabled();
  await submit.click();
  const account = page.getByRole("dialog", { name: "纬线账号" });
  if (await account.isVisible()) {
    await account.getByLabel("邮箱").fill("creator@example.com");
    await account.getByLabel("密码").fill("password");
    await account.getByRole("button", { name: "进入画布" }).click();
    await expect(account).toBeHidden();
    await expect(submit).toBeEnabled();
    await submit.click();
  }
  const generatedImage = studio.locator("img[alt='生成的图片结果']");
  await expect(generatedImage).toBeVisible();
  const previewPixels = await generatedImage.evaluate((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    let nonBlack = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] === 0) continue;
      visible += 1;
      if (pixels[index] !== 0 || pixels[index + 1] !== 0 || pixels[index + 2] !== 0) nonBlack += 1;
    }
    return { width: image.naturalWidth, height: image.naturalHeight, visible, nonBlack };
  });
  expect(previewPixels.width).toBe(128);
  expect(previewPixels.height).toBe(128);
  expect(previewPixels.visible).toBeGreaterThan(0);
  expect(previewPixels.nonBlack).toBeGreaterThan(0);
  await expect.poll(() => hasCachedMedia(page, "media-image")).toBe(true);
  const readsBeforeRefresh = readGeneratedImageReads();
  disableGeneratedImage();
  await page.reload();
  await expect(page.locator("[data-direct-generation] img[alt='生成的图片结果']")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  expect(readGeneratedImageReads()).toBe(readsBeforeRefresh);
  await page.screenshot({ path: testInfo.outputPath("direct-image-result.png"), fullPage: false });
  await page.getByRole("button", { name: "删除图片结果" }).click();
  await expect(page.locator("[data-direct-generation] img[alt='生成的图片结果']")).toHaveCount(0);
  await expect.poll(() => hasCachedMedia(page, "media-image")).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "删除图片结果" })).toHaveCount(0);
  await expect(page.locator("[data-direct-generation] img[alt='生成的图片结果']")).toHaveCount(0);
  const submission = readSubmission();
  expect(submission?.projectId).toBe("home-direct-generation");
  expect(submission?.nodeId).toBe("home-direct-image");
  expect(submission?.inputs).toEqual({
    images: [uploadedMediaId],
    styleImages: [],
    elementImages: [],
    videos: [],
    audios: [],
  });
  expect(readMediaUploadRequest()).toMatchObject({
    kind: "image",
    name: "reference.png",
    mimeType: "image/png",
  });
});

test("standalone audio generation submits a hosted job and renders a playable result", async ({
  page,
}) => {
  const { readSubmission } = await mockDirectApis(page);
  await page.goto("/generate/audio");

  const studio = page.locator("[data-direct-generation]");
  await expect(studio).toHaveAttribute("data-direct-modality", "audio");
  await expect(studio.getByRole("button", { name: "模型" })).toContainText("首页音频模型");
  // 音频模型没有媒体输入：素材区不出现。
  await expect(studio.locator(".wc-direct-materials")).toHaveCount(0);
  await studio.locator("[data-direct-prompt]").fill("轻快的钢琴背景音乐");
  const submit = studio.locator(".wc-direct-submit");
  await expect(submit).toBeEnabled();
  await submit.click();
  const account = page.getByRole("dialog", { name: "纬线账号" });
  if (await account.isVisible()) {
    await account.getByLabel("邮箱").fill("creator@example.com");
    await account.getByLabel("密码").fill("password");
    await account.getByRole("button", { name: "进入画布" }).click();
    await expect(account).toBeHidden();
    await expect(submit).toBeEnabled();
    await submit.click();
  }
  const tile = studio.locator("figure.wc-direct-result-tile.is-audio");
  await expect(tile).toBeVisible();
  const audio = tile.locator("audio");
  await expect(audio).toHaveAttribute("aria-label", /轻快的钢琴背景音乐/);
  await expect
    .poll(() => audio.evaluate((element) => element.canPlayType("audio/mpeg") !== ""))
    .toBe(true);
  const submission = readSubmission();
  expect(submission?.projectId).toBe("home-direct-generation");
  expect(submission?.nodeId).toBe("home-direct-audio");
  expect(submission?.modality).toBe("audio");
});

async function hasCachedMedia(page: Page, mediaId: string) {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      // 与 media-database.ts 的 DATABASE_VERSION 保持一致：用更低的版本打开
      // 已存在的库会直接抛 VersionError。
      const request = indexedDB.open("weftcanvas-media", 2);
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

test("standalone Omni generation assigns semantic image roles before quote and submit", async ({
  page,
}, testInfo) => {
  const { readSubmission, readQuoteRequest, uploadedMediaId } = await mockDirectApis(page, {
    video: [omniVideoModel()],
  });
  await page.goto("/generate/video");

  const studio = page.locator("[data-direct-generation]");
  await studio.locator("[data-direct-prompt]").fill("Preserve the product identity and animate it");
  await studio.locator("[data-direct-material-input='image']").setInputFiles({
    name: "product.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(studio.locator(".wc-direct-material-item.is-ready")).toHaveCount(1);
  await expect(studio).toContainText("请为 1 张参考图片选择用途");
  await expect(studio.locator(".wc-direct-submit")).toBeDisabled();

  await studio.getByRole("button", { name: "product.png的参考用途" }).click();
  await page.getByRole("option", { name: /元素图/ }).click();
  await expect
    .poll(() => readQuoteRequest()?.inputs)
    .toEqual({
      images: 0,
      styleImages: 0,
      elementImages: 1,
      videos: 0,
      audios: 0,
    });
  await page.screenshot({
    path: testInfo.outputPath("direct-omni-role-desktop.png"),
    fullPage: false,
  });

  const submit = studio.locator(".wc-direct-submit");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(readSubmission).not.toBeNull();
  expect(readSubmission()?.inputs).toEqual({
    images: [],
    styleImages: [],
    elementImages: [uploadedMediaId],
    videos: [],
    audios: [],
  });
});

test("standalone materials wait for a pending session instead of opening a false login", async ({
  page,
}) => {
  const { readAuthHits } = await mockDirectApis(
    page,
    {
      video: [omniVideoModel()],
    },
    { authDelayMs: 1_000 },
  );
  await page.goto("/generate/video");

  const studio = page.locator("[data-direct-generation]");
  await studio.locator("[data-direct-material-input='image']").setInputFiles({
    name: "session-race.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });

  await expect.poll(readAuthHits).toBeGreaterThan(0);
  await expect(studio.locator(".wc-direct-material-item.is-ready")).toHaveCount(1);
  await expect(page.locator(".wc-account-backdrop")).toHaveCount(0);
});

test("standalone Omni image-role selection stays usable on a mobile viewport", async ({
  page,
}, testInfo) => {
  const { readQuoteRequest } = await mockDirectApis(page, {
    video: [omniVideoModel()],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/generate/video");

  const studio = page.locator("[data-direct-generation]");
  await studio.locator("[data-direct-prompt]").fill("Animate this reference");
  await studio.locator("[data-direct-material-input='image']").setInputFiles({
    name: "mobile-product.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });

  const material = studio.locator(".wc-direct-material-item.is-ready");
  await expect(material).toHaveCount(1);
  const purpose = studio.getByRole("button", { name: "mobile-product.png的参考用途" });
  await expect(purpose).toBeVisible();
  await purpose.click();
  await page.getByRole("option", { name: /风格图/ }).click();
  await expect
    .poll(() => readQuoteRequest()?.inputs)
    .toEqual({
      images: 0,
      styleImages: 1,
      elementImages: 0,
      videos: 0,
      audios: 0,
    });

  const layout = await page.locator(".wc-direct-page").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(layout.scrollWidth).toBe(layout.clientWidth);
  await page.screenshot({
    path: testInfo.outputPath("direct-omni-role-mobile.png"),
    fullPage: false,
  });
});

test("standalone video generation uploads server references and renders a cached playable result", async ({
  page,
}, testInfo) => {
  const {
    readSubmission,
    readAuthHits,
    readQuoteRequest,
    readMediaUploadRequests,
    uploadedMediaIds,
  } = await mockDirectApis(page);
  await page.goto("/generate/video");
  await expect.poll(readAuthHits).toBeGreaterThan(0);

  const studio = page.locator("[data-direct-generation]");
  await studio.locator("[data-direct-prompt]").fill("Animate the subject with matching sound");
  await studio.locator("[data-direct-material-input='video']").setInputFiles({
    name: "reference.mp4",
    mimeType: "video/mp4",
    buffer: generatedVideoFixture,
  });
  await expect(studio.locator(".wc-direct-material-item.is-ready")).toHaveCount(1);
  await studio.locator("[data-direct-material-input='audio']").setInputFiles({
    name: "reference.mp3",
    mimeType: "audio/mpeg",
    buffer: generatedAudioFixture,
  });
  await expect(studio.locator(".wc-direct-material-item.is-ready")).toHaveCount(2);
  await expect
    .poll(() => readQuoteRequest()?.inputs)
    .toEqual({ images: 0, styleImages: 0, elementImages: 0, videos: 1, audios: 1 });

  const submit = studio.locator(".wc-direct-submit");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(readSubmission).not.toBeNull();

  const submission = readSubmission();
  expect(submission?.projectId).toBe("home-direct-generation");
  expect(submission?.nodeId).toBe("home-direct-video");
  expect(submission?.inputs).toEqual({
    images: [],
    styleImages: [],
    elementImages: [],
    videos: [uploadedMediaIds.video],
    audios: [uploadedMediaIds.audio],
  });
  expect(JSON.stringify(submission?.inputs)).not.toMatch(/(?:blob:|data:|https?:\/\/)/);
  expect(readMediaUploadRequests()).toEqual([
    expect.objectContaining({ kind: "video", name: "reference.mp4", mimeType: "video/mp4" }),
    expect.objectContaining({ kind: "audio", name: "reference.mp3", mimeType: "audio/mpeg" }),
  ]);
  const generatedVideo = studio.locator(".wc-direct-result-media--video video");
  await expect(generatedVideo).toBeVisible();
  await expect(generatedVideo).toHaveAttribute("src", "/api/v1/media/media-video/content");
  await expect
    .poll(() => generatedVideo.evaluate((video) => video.readyState))
    .toBeGreaterThanOrEqual(2);
  await expect.poll(() => generatedVideo.evaluate((video) => video.videoWidth)).toBeGreaterThan(0);
  await expect.poll(() => generatedVideo.evaluate((video) => video.videoHeight)).toBeGreaterThan(0);
  await expect.poll(() => videoFrameNonBlackRatio(generatedVideo)).toBeGreaterThan(0.02);
  await expect.poll(() => hasCachedMedia(page, "media-video")).toBe(true);
  await page.reload();
  const restoredVideo = page.locator(
    "[data-direct-generation] .wc-direct-result-media--video video",
  );
  await expect(restoredVideo).toBeVisible();
  await expect(restoredVideo).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() => restoredVideo.evaluate((video) => video.readyState))
    .toBeGreaterThanOrEqual(2);
  await expect.poll(() => restoredVideo.evaluate((video) => video.videoWidth)).toBeGreaterThan(0);
  await expect.poll(() => restoredVideo.evaluate((video) => video.videoHeight)).toBeGreaterThan(0);
  await expect.poll(() => videoFrameNonBlackRatio(restoredVideo)).toBeGreaterThan(0.02);
  await page.screenshot({ path: testInfo.outputPath("direct-video-result.png"), fullPage: false });
  await page.getByRole("button", { name: "删除视频结果" }).click();
  await expect(
    page.locator("[data-direct-generation] .wc-direct-result-media--video video"),
  ).toHaveCount(0);
  await expect.poll(() => hasCachedMedia(page, "media-video")).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "删除视频结果" })).toHaveCount(0);
  await expect(
    page.locator("[data-direct-generation] .wc-direct-result-media--video video"),
  ).toHaveCount(0);
});

test("standalone workbench materials survive refresh and submission until the user clears them", async ({
  page,
}) => {
  test.slow();
  const { readAuthHits, readSubmission, readMediaUploadRequests } = await mockDirectApis(page);
  await page.goto("/generate/image");
  await expect.poll(readAuthHits).toBeGreaterThan(0);
  const studio = page.locator("[data-direct-generation]");

  await studio.locator("[data-direct-material-input='image']").setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(studio.locator(".wc-direct-material-item")).toContainText("已上传");
  expect(readMediaUploadRequests()).toHaveLength(1);

  // 提示词与模型参数（画质）也会在刷新后保留。
  await studio.locator("[data-direct-prompt]").fill("一座被雨水照亮的未来城市");
  await studio
    .getByRole("group", { name: "画质" })
    .getByRole("radio", { name: "1k", exact: true })
    .click();
  await expect(
    studio.getByRole("group", { name: "画质" }).getByRole("radio", { name: "1k", exact: true }),
  ).toHaveAttribute("aria-checked", "true");

  // 刷新网页：素材从标签页会话恢复，无需重新上传；草稿同样恢复。
  await page.reload();
  await expect(studio.locator(".wc-direct-material-item")).toContainText("reference.png");
  await expect(studio.locator(".wc-direct-material-item")).toContainText("已上传");
  await expect(studio.locator("[data-direct-prompt]")).toHaveValue("一座被雨水照亮的未来城市");
  await expect(
    studio.getByRole("group", { name: "画质" }).getByRole("radio", { name: "1k", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  expect(readMediaUploadRequests()).toHaveLength(1);

  // 提交一次生成后素材与草稿仍然保留。
  const submit = studio.locator(".wc-direct-submit");
  await expect(submit).toBeEnabled();
  await submit.click();
  const account = page.getByRole("dialog", { name: "纬线账号" });
  if (await account.isVisible()) {
    await account.getByLabel("邮箱").fill("creator@example.com");
    await account.getByLabel("密码").fill("password");
    await account.getByRole("button", { name: "进入画布" }).click();
    await expect(account).toBeHidden();
    await expect(submit).toBeEnabled();
    await submit.click();
  }
  await expect.poll(readSubmission).not.toBeNull();
  await expect(studio.locator("img[alt='生成的图片结果']")).toBeVisible();
  await expect(studio.locator(".wc-direct-material-item")).toContainText("已上传");

  // 提交后再刷新：素材仍在，且只有一次上传记录；草稿也仍在。
  await page.reload();
  await expect(studio.locator(".wc-direct-material-item")).toContainText("reference.png");
  await expect(studio.locator(".wc-direct-material-item")).toContainText("已上传");
  await expect(studio.locator("[data-direct-prompt]")).toHaveValue("一座被雨水照亮的未来城市");
  await expect(
    studio.getByRole("group", { name: "画质" }).getByRole("radio", { name: "1k", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  expect(readMediaUploadRequests()).toHaveLength(1);

  // 点击"清空上传素材"：先取消，素材保留；再确认，素材清空。
  await studio.getByRole("button", { name: "清空上传素材" }).click();
  const confirm = page.getByRole("dialog", { name: "清空上传素材" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "取消" }).click();
  await expect(confirm).toBeHidden();
  await expect(studio.locator(".wc-direct-material-item")).toContainText("已上传");
  await studio.getByRole("button", { name: "清空上传素材" }).click();
  await confirm.getByRole("button", { name: "清空", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(studio.locator(".wc-direct-material-item")).toHaveCount(0);

  // 清空后再次刷新：素材不会恢复。
  await page.reload();
  await expect(studio.locator(".wc-direct-material-item")).toHaveCount(0);
});

test("leaving the workbench clears the uploaded materials session", async ({ page }) => {
  const { readAuthHits } = await mockDirectApis(page);
  await page.goto("/generate/image");
  await expect.poll(readAuthHits).toBeGreaterThan(0);
  const studio = page.locator("[data-direct-generation]");
  await studio.locator("[data-direct-material-input='image']").setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(studio.locator(".wc-direct-material-item")).toContainText("已上传");

  // 草稿也先写入一份，验证离开工作台时一并清空。
  await studio.locator("[data-direct-prompt]").fill("一座被雨水照亮的未来城市");

  // 通过品牌链接返回首页（离开工作台），会话存储应被清空。
  await page.getByRole("link", { name: "返回纬线首页" }).click();
  await expect(page.locator(".wc-entry-gate")).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("weftcanvas:direct-reference-session:v1")),
  ).toBeNull();
  expect(
    await page.evaluate(() => sessionStorage.getItem("weftcanvas:direct-draft-session:v1")),
  ).toBeNull();

  // 再次进入工作台：素材与草稿都不会恢复。
  await page.goto("/generate/image");
  await expect.poll(readAuthHits).toBeGreaterThan(0);
  await expect(studio.locator(".wc-direct-material-item")).toHaveCount(0);
  await expect(studio.locator("[data-direct-prompt]")).toHaveValue("");
});

test("standalone generation accepts dropped and pasted file materials without intercepting plain prompt text", async ({
  page,
}) => {
  const imageOnlyVideoModel = {
    ...model("video"),
    input: {
      textRequired: true,
      images: { min: 0, max: 2, multiple: true },
      videos: { min: 0, max: 0, multiple: false },
      audios: { min: 0, max: 0, multiple: false },
    },
  };
  const { readAuthHits, readMediaUploadRequests } = await mockDirectApis(page, {
    video: [imageOnlyVideoModel],
  });
  await page.goto("/generate/video");
  await expect.poll(readAuthHits).toBeGreaterThan(0);

  const studio = page.locator("[data-direct-generation]");
  const dropzone = studio.locator("[data-direct-material-dropzone]");
  const prompt = studio.locator("[data-direct-prompt]");
  const pngBytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
    0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ];

  await dropzone.evaluate((element, bytes) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File([new Uint8Array(bytes)], "dropped-reference.png", { type: "image/png" }),
    );
    element.dispatchEvent(
      new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }),
    );
  }, pngBytes);
  await expect(dropzone).toHaveClass(/is-drag-active/);
  await dropzone.evaluate((element, bytes) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File([new Uint8Array(bytes)], "dropped-reference.png", { type: "image/png" }),
    );
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  }, pngBytes);
  await expect(dropzone).not.toHaveClass(/is-drag-active/);
  await expect.poll(readMediaUploadRequests).toContainEqual(
    expect.objectContaining({
      kind: "image",
      name: "dropped-reference.png",
      mimeType: "image/png",
    }),
  );

  const textPastePrevented = await prompt.evaluate((element) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", "plain prompt text");
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(textPastePrevented).toBe(false);

  const filePastePrevented = await prompt.evaluate((element, bytes) => {
    const dataTransfer = new DataTransfer();
    // Deliberately omit a MIME type and extension: content sniffing must still route this image correctly.
    dataTransfer.items.add(new File([new Uint8Array(bytes)], "clipboard-material", { type: "" }));
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, pngBytes);
  expect(filePastePrevented).toBe(true);
  await expect.poll(readMediaUploadRequests).toContainEqual(
    expect.objectContaining({
      kind: "image",
      name: "clipboard-material",
      mimeType: "image/png",
    }),
  );

  const uploadsBeforeUnsupportedDrop = readMediaUploadRequests().length;
  await dropzone.evaluate((element) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File(
        [new Uint8Array([0x52, 0x49, 0x46, 0x46, 36, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])],
        "unsupported-audio.wav",
        { type: "audio/wav" },
      ),
    );
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(dropzone.getByRole("alert")).toBeVisible();
  expect(readMediaUploadRequests()).toHaveLength(uploadsBeforeUnsupportedDrop);
});

for (const modality of ["image", "video"] as const) {
  test(
    "standalone " + modality + " generation inserts uploaded materials from the @ menu",
    async ({ page }) => {
      await mockDirectApis(page);
      await page.goto("/generate/" + modality);

      const studio = page.locator("[data-direct-generation]");
      await studio.locator("[data-direct-material-input='image']").setInputFiles({
        name: modality + "-mention.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      });
      await expect(studio.locator(".wc-direct-material-item.is-ready")).toHaveCount(1);

      const prompt = studio.locator("[data-direct-prompt]");
      await prompt.fill("请参考 @");
      const menu = studio.getByRole("listbox", { name: "引用素材" });
      await expect(menu).toBeVisible();
      const materialOption = menu.getByRole("option");
      await expect(materialOption).toContainText("@图片1");
      await expect(materialOption).toContainText(modality + "-mention.png");
      await menu.getByRole("option").click();
      await expect(prompt).toHaveValue("请参考 @图片1 ");

      await studio
        .getByRole("button", { name: new RegExp("移除" + modality + "-mention\\.png") })
        .click();
      await expect(prompt).toHaveValue("请参考  ");
    },
  );
}

test("standalone video generation opens in video mode and stays within the mobile viewport", async ({
  page,
}, testInfo) => {
  await mockDirectApis(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/generate/video");
  await expect(page).toHaveURL(/\/generate\/video$/);
  await expect(page.locator(".wc-direct-page")).toHaveAttribute("aria-label", "视频生成页面");
  const studio = page.locator("[data-direct-generation]");
  await expect(studio).toHaveAttribute("data-direct-modality", "video");
  await expect(studio.getByRole("button", { name: "模型" })).toContainText("首页视频模型");
  await expect(studio.locator("[data-direct-prompt]")).toBeVisible();
  const durationGroup = studio.getByRole("group", { name: "时长" });
  await expect(durationGroup.getByRole("radio", { name: "5", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(durationGroup.getByRole("radio", { name: "10", exact: true })).toBeVisible();
  await expect(studio.locator(".wc-direct-parameters input[type='number']")).toHaveCount(0);
  await expect(studio.getByText("参考图片链接")).toHaveCount(0);
  await expect(studio.locator("[data-direct-material-input='image']")).toHaveCount(1);
  await expect(studio.locator("[data-direct-material-input='video']")).toHaveCount(1);
  const canvasLink = page.getByRole("link", { name: "打开画布" });
  await expect(canvasLink).toHaveAttribute("href", "/canvas");
  const canvasLinkIcon = canvasLink.locator("svg");
  await expect(canvasLinkIcon).toBeVisible();
  await expect(canvasLinkIcon).toHaveCSS("display", "block");
  await expect(canvasLinkIcon).toHaveCSS("color", "rgb(16, 18, 17)");

  const imageTab = studio.getByRole("tab", { name: /图片生成/ });
  await expect(imageTab).toBeVisible();
  await imageTab.click();
  await expect(page).toHaveURL(/\/generate\/image$/);
  await expect(studio).toHaveAttribute("data-direct-modality", "image");

  await page.screenshot({ path: testInfo.outputPath("direct-video-mobile.png"), fullPage: false });
  const dimensions = await page.locator(".wc-direct-page").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  const documentDimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(documentDimensions.scrollWidth).toBe(documentDimensions.clientWidth);
});

test("video duration chips stay in a short viewport and can select 13 then 15 seconds", async ({
  page,
}) => {
  const videoModel = model("video");
  videoModel.parameters = videoModel.parameters.map((parameter) =>
    parameter.name === "duration" ? { ...parameter, max: 15 } : parameter,
  );
  await mockDirectApis(page, { video: [videoModel] });
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto("/generate/video");

  const studio = page.locator("[data-direct-generation]");
  const durationGroup = studio.getByRole("group", { name: "时长" });
  await durationGroup.scrollIntoViewIfNeeded();

  const thirteen = durationGroup.getByRole("radio", { name: "13", exact: true });
  await thirteen.scrollIntoViewIfNeeded();
  await thirteen.click();
  await expect(thirteen).toHaveAttribute("aria-checked", "true");

  const fifteen = durationGroup.getByRole("radio", { name: "15", exact: true });
  await fifteen.scrollIntoViewIfNeeded();
  await expect(fifteen).toBeVisible();
  await fifteen.click();
  await expect(fifteen).toHaveAttribute("aria-checked", "true");
});

test("live long-form video capabilities keep their catalog duration and material limits", async ({
  page,
}) => {
  const videoModel = {
    ...model("video"),
    id: "S-2.5-满血",
    label: "S-2.5-满血",
    input: {
      textRequired: true,
      images: { min: 0, max: 30, multiple: true },
      videos: { min: 0, max: 10, multiple: true },
      audios: { min: 0, max: 10, multiple: true },
      referenceMedia: {
        images: { min: 0, max: 30, multiple: true },
        videos: { min: 0, max: 10, multiple: true },
        audios: { min: 0, max: 10, multiple: true },
      },
    },
    parameters: model("video").parameters.map((parameter) =>
      parameter.name === "duration"
        ? { ...parameter, label: "时长（秒）", min: 4, max: 30, default: 4 }
        : parameter,
    ),
  };
  await mockDirectApis(page, { video: [videoModel] });
  await page.goto("/generate/video");

  const studio = page.locator("[data-direct-generation]");
  await expect(studio.getByRole("button", { name: "模型" })).toContainText("S-2.5-满血");
  const materialActions = studio.locator(".wc-direct-material-actions");
  await expect(materialActions.locator("label").filter({ hasText: "图片素材" })).toContainText(
    "0/30",
  );
  await expect(materialActions.locator("label").filter({ hasText: "视频素材" })).toContainText(
    "0/10",
  );
  await expect(materialActions.locator("label").filter({ hasText: "音频素材" })).toContainText(
    "0/10",
  );

  const durationGroup = studio.getByRole("group", { name: "时长（秒）" });
  const thirty = durationGroup.getByRole("radio", { name: "30", exact: true });
  await thirty.scrollIntoViewIfNeeded();
  await thirty.click();
  await expect(thirty).toHaveAttribute("aria-checked", "true");
});
