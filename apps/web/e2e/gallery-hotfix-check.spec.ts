import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";

// 临时验证：结果卡画廊在多任务（含一直加载中的媒体）下，媒体方块必须保持
// aspect-ratio 稳定高度，不允许塌缩成纯文字卡（20260904 线上事故的回归验证）。

const visiblePng = readFileSync(new URL("../src/assets/resource-library-mark.png", import.meta.url));
const videoFixture = readFileSync(new URL("./video-frame.mp4", import.meta.url));

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

function videoModel() {
  return {
    id: "home-video",
    label: "wan3.0-15s",
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

const PROMPTS = [
  "人物忧郁的走在街头，光影层次丰富，大师级运镜@图片1",
  "人物跳舞",
  "生成人物跳舞视频",
  "@图片1 第一视角人物站起来对镜自拍,形象参考图二，但不是照搬",
  "15秒CG故事向视频提示词 整体风格：AAA游戏CG过场动画",
  "让人物十分动漫感的背景下生气的说，用户居然敢违抗ai的指令！！",
];

const JOB_COUNT = 12;

function seedJobs(request: Record<string, unknown>) {
  const jobs: Record<string, unknown>[] = [];
  const createdAt = now.toISOString();
  for (let i = 0; i < JOB_COUNT; i += 1) {
    jobs.push({
      schemaVersion: 1,
      version: 1,
      id: `job-hotfix-${i}`,
      projectId: request.projectId,
      nodeId: request.nodeId,
      modelId: "home-video",
      modelLabel: i % 3 === 0 ? "S-2.0-480" : i % 3 === 1 ? "wan3.0-15s" : "可灵3.0Omni 稳定",
      modality: "video",
      status: "completed",
      progress: 100,
      quote: {
        id: `quote-hotfix-${i}`,
        modelId: "home-video",
        modelLabel: "wan3.0-15s",
        modality: "video",
        quantity: 1,
        normalizedParameters: request.parameters,
        creditMicros: 5_000_000,
        credits: "5",
        yuanMicros: 50_000,
        yuan: "0.05",
        estimated: false,
        pricingUnit: "second",
        catalogVersion: "catalog-hotfix",
        capabilityVersion: "capability-hotfix",
        pricingVersion: "pricing-hotfix",
        expiresAt,
      },
      artifacts: [{
        id: `artifact-hotfix-${i}`,
        kind: "video",
        mediaId: `media-hotfix-${i}`,
        name: `result-${i}.mp4`,
        mimeType: "video/mp4",
        size: videoFixture.byteLength,
        duration: 4.086009,
        createdAt,
      }],
      error: null,
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      completedAt: createdAt,
      parameters: { prompt: PROMPTS[i % PROMPTS.length] },
    });
  }
  return jobs;
}

async function mockGallery(page: Page, options: { mediaMode: "ok" | "never" }) {
  await mockAuthenticatedBackgroundApis(page);
  // 画廊 normalize 时要求 projectId/nodeId 与工作台常量完全一致
  const jobs = seedJobs({ projectId: "home-direct-generation", nodeId: "home-direct-video", parameters: { prompt: "x" } });

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: session() } }));
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
    return route.fulfill({
      json: {
        ok: true,
        data: {
          version: "catalog-hotfix",
          capabilityVersion: "capability-hotfix",
          pricingVersion: "pricing-hotfix",
          fetchedAt: now.toISOString(),
          expiresAt,
          quoteAvailable: true,
          models: [videoModel()],
        },
      },
    });
  });
  await page.route("**/api/v1/generation-jobs*", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { ok: true, data: jobs } });
    return route.fulfill({ status: 202, json: { ok: true, data: jobs[0] } });
  });
  await page.route("**/api/v1/generation-jobs/*", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.route(/\/api\/v1\/media\/media-hotfix-\d+\/content.*/, async (route) => {
    if (options.mediaMode === "never") {
      // 一直挂着不响应：模拟用户遇到的“加载中”卡死场景
      return new Promise(() => undefined);
    }
    return route.fulfill({ body: videoFixture, contentType: "video/mp4" });
  });
}

async function measureGallery(page: Page) {
  return page.evaluate(() => {
    const tiles = [...document.querySelectorAll(".kc-direct-result-tile")];
    return tiles.slice(0, 6).map((tile) => {
      const media = tile.querySelector(".kc-direct-result-media");
      const mr = media?.getBoundingClientRect();
      const tr = tile.getBoundingClientRect();
      const img = media?.querySelector("img");
      const video = media?.querySelector("video");
      return {
        tileH: Math.round(tr.height),
        mediaH: mr ? Math.round(mr.height) : null,
        mediaW: mr ? Math.round(mr.width) : null,
        hasImg: Boolean(img),
        imgVisible: img ? img.getBoundingClientRect().height > 10 : false,
        hasVideo: Boolean(video),
      };
    });
  });
}

test("gallery keeps media square when all media load", async ({ page }) => {
  await mockGallery(page, { mediaMode: "ok" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/generate/video");
  await page.waitForSelector(".kc-direct-result-tile", { timeout: 20_000 });
  await page.waitForTimeout(2_500);
  const tiles = await measureGallery(page);
  console.log("MEDIA-OK:", JSON.stringify(tiles));
  for (const t of tiles) {
    // 固定四列后媒体随列宽变小：断言"方形且不塌缩"而非绝对尺寸
    expect(t.mediaH).toBeGreaterThan(80);
    expect(Math.abs(t.mediaH - t.mediaW)).toBeLessThanOrEqual(2);
  }
  await page.screenshot({ path: "test-results/gallery-ok.png", fullPage: false });
});

test("gallery keeps media square while media never resolve (loading)", async ({ page }) => {
  await mockGallery(page, { mediaMode: "never" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/generate/video");
  await page.waitForSelector(".kc-direct-result-tile", { timeout: 20_000 });
  await page.waitForTimeout(2_500);
  const tiles = await measureGallery(page);
  console.log("MEDIA-NEVER:", JSON.stringify(tiles));
  for (const t of tiles) {
    // 固定四列后媒体随列宽变小：断言"方形且不塌缩"而非绝对尺寸
    expect(t.mediaH).toBeGreaterThan(80);
    expect(Math.abs(t.mediaH - t.mediaW)).toBeLessThanOrEqual(2);
  }
  await page.screenshot({ path: "test-results/gallery-never.png", fullPage: false });
});
