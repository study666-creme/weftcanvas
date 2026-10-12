import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";

// 结果画廊布局回归：①固定四列 ②生成占位与同行卡片同高（不留白）
// ③浅色主题下卡片文字仍为深底浅字（卡片 token 与主题解耦）。

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
      {
        name: "prompt",
        label: "提示词",
        type: "string",
        required: true,
        mutuallyExclusiveWith: [],
      },
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

function completedJob(i: number) {
  const createdAt = now.toISOString();
  return {
    schemaVersion: 1,
    version: 1,
    id: `job-hotfix-${i}`,
    projectId: "home-direct-generation",
    nodeId: "home-direct-video",
    modelId: "home-video",
    modelLabel: "S-2.0mini-线路三",
    modality: "video",
    status: "completed",
    progress: 100,
    quote: {
      id: `q-${i}`,
      modelId: "home-video",
      modelLabel: "wan3.0-15s",
      modality: "video",
      quantity: 1,
      normalizedParameters: { prompt: "人物跳舞" },
      creditMicros: 5_000_000,
      credits: "5",
      yuanMicros: 50_000,
      yuan: "0.05",
      estimated: false,
      pricingUnit: "second",
      catalogVersion: "c",
      capabilityVersion: "c",
      pricingVersion: "c",
      expiresAt,
    },
    artifacts: [
      {
        id: `a-${i}`,
        kind: "video",
        mediaId: `media-hotfix-${i}`,
        name: `r-${i}.mp4`,
        mimeType: "video/mp4",
        size: videoFixture.byteLength,
        duration: 4.086009,
        createdAt,
      },
    ],
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
    inputs: { images: [`media-ref-${i}-a`, `media-ref-${i}-b`], videos: [], audios: [] },
    parameters: { prompt: `第${i}组，用时15秒，剧情：人物跳舞` },
  };
}

function runningJob() {
  const createdAt = now.toISOString();
  return {
    schemaVersion: 1,
    version: 1,
    id: "job-running",
    projectId: "home-direct-generation",
    nodeId: "home-direct-video",
    modelId: "home-video",
    modelLabel: "S-2.0mini-线路三",
    modality: "video",
    status: "running",
    progress: 42,
    quote: {
      id: "q-running",
      modelId: "home-video",
      modelLabel: "wan3.0-15s",
      modality: "video",
      quantity: 1,
      normalizedParameters: { prompt: "人物跳舞" },
      creditMicros: 5_000_000,
      credits: "5",
      yuanMicros: 50_000,
      yuan: "0.05",
      estimated: false,
      pricingUnit: "second",
      catalogVersion: "c",
      capabilityVersion: "c",
      pricingVersion: "c",
      expiresAt,
    },
    artifacts: [],
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: null,
    parameters: { prompt: "生成中任务" },
  };
}

async function mockGallery(page: Page) {
  await mockAuthenticatedBackgroundApis(page);
  const jobs = [runningJob(), ...Array.from({ length: 5 }, (_, i) => completedJob(i))];
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: session() } }),
  );
  await page.route("**/api/v1/wallet**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          credits: 88.5,
          creditsPermanent: 80,
          dailyCredits: 8.5,
          creditGrantMode: "bundle",
          dailyCreditsNote: "每日 00:00 刷新",
          membership: { tier: null, until: null, active: false, genDiscount: null },
          lifetimeCreditsSpent: 0,
        },
      },
    }),
  );
  await page.route("**/api/v1/model-catalog**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          version: "c",
          capabilityVersion: "c",
          pricingVersion: "c",
          fetchedAt: now.toISOString(),
          expiresAt,
          quoteAvailable: true,
          models: [videoModel()],
        },
      },
    }),
  );
  await page.route("**/api/v1/generation-jobs*", (route) => {
    if (route.request().method() !== "POST")
      return route.fulfill({ json: { ok: true, data: jobs } });
    return route.fulfill({ status: 202, json: { ok: true, data: jobs[0] } });
  });
  await page.route("**/api/v1/generation-jobs/*", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.route(/\/api\/v1\/media\/media-hotfix-\d+\/content.*/, (route) =>
    route.fulfill({ body: videoFixture, contentType: "video/mp4" }),
  );
}

test("gallery layout: three columns, generating tile mirrors result cards, theme-proof text", async ({
  page,
}) => {
  await mockGallery(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/generate/video");
  await page.waitForSelector(".wc-direct-result-tile", { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const measure = () =>
    page.evaluate(() => {
      const gallery = document.querySelector(".wc-direct-result-gallery") as HTMLElement;
      const gcs = getComputedStyle(gallery);
      const genTile = document.querySelector(
        ".wc-direct-result-tile.is-generating",
      ) as HTMLElement | null;
      const tiles = [
        ...document.querySelectorAll<HTMLElement>(".wc-direct-result-tile:not(.is-generating)"),
      ];
      const tile = tiles[0];
      const genMedia = genTile?.querySelector(".wc-direct-result-media") as HTMLElement | null;
      const resultMedia = tile?.querySelector(".wc-direct-result-media") as HTMLElement | null;
      const caption = tile?.querySelector(".wc-direct-result-caption") as HTMLElement | null;
      const model = tile?.querySelector(".wc-direct-result-model") as HTMLElement | null;
      const controls = [
        ...(tile?.querySelectorAll<HTMLElement>(".wc-direct-result-controls > *") ?? []),
      ];
      const controlTops = controls.map((el) => Math.round(el.getBoundingClientRect().top));
      const genCaption = genTile?.querySelector(".wc-direct-result-caption") as HTMLElement | null;
      const genReuse = genTile?.querySelector(
        "button[aria-label='复用提示词']",
      ) as HTMLButtonElement | null;
      return {
        galleryW: Math.round(gallery.getBoundingClientRect().width),
        columns: gcs.gridTemplateColumns,
        captionColor: caption ? getComputedStyle(caption).color : null,
        modelColor: model ? getComputedStyle(model).color : null,
        tileH: tile ? Math.round(tile.getBoundingClientRect().height) : null,
        tileW: tile ? Math.round(tile.getBoundingClientRect().width) : null,
        resultMediaH: resultMedia ? Math.round(resultMedia.getBoundingClientRect().height) : null,
        genMediaH: genMedia ? Math.round(genMedia.getBoundingClientRect().height) : null,
        aligned: controlTops.every((top) => Math.abs(top - controlTops[0]!) <= 2),
        genCaptionText: genCaption?.textContent?.slice(0, 12) ?? null,
        genHasReuse: Boolean(genReuse),
        resultReuseCount: tile?.querySelectorAll("button[aria-label='复用提示词']").length ?? 0,
        resultRefReuseCount: tile?.querySelectorAll("button[aria-label='复用参考图']").length ?? 0,
      };
    });

  const dark = await measure();
  console.log("PROBE-DARK:", JSON.stringify(dark));

  // 强制切浅色主题（默认 :root token，文字变量变近黑），卡片文字必须仍然可读
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.waitForTimeout(300);
  const light = await page.evaluate(() => {
    const tile = document.querySelector(".wc-direct-result-tile") as HTMLElement;
    const caption = tile?.querySelector(".wc-direct-result-caption") as HTMLElement | null;
    const model = tile?.querySelector(".wc-direct-result-model") as HTMLElement | null;
    return {
      captionColor: caption ? getComputedStyle(caption).color : null,
      modelColor: model ? getComputedStyle(model).color : null,
      tileBg: tile ? getComputedStyle(tile).backgroundColor : null,
    };
  });
  console.log("PROBE-LIGHT:", JSON.stringify(light));

  expect(dark.columns.split(" ").length).toBe(3);
  // 生成占位卡与结果卡同构：模型名/提示词/复用按钮齐全，媒体方块同高（视觉对称）
  expect(dark.tileW).toBeGreaterThan(0);
  expect(dark.resultMediaH).toBeGreaterThan(80);
  expect(Math.abs((dark.resultMediaH ?? 0) - (dark.genMediaH ?? 0))).toBeLessThanOrEqual(2);
  expect(dark.genHasReuse).toBe(true);
  expect(dark.genCaptionText).toBeTruthy();
  expect(dark.resultReuseCount).toBe(1);
  // 提交时带参考图的任务，卡片上要有"复用参考图"按钮
  expect(dark.resultRefReuseCount).toBe(1);
  // 同一行按钮顶边对齐（漂移 <= 2px）
  expect(dark.aligned).toBe(true);
  // 浅色主题下卡片文字仍是浅色（亮度 > 0.6）
  for (const color of [light.captionColor, light.modelColor]) {
    const m = /rgba?\((\d+), (\d+), (\d+)/.exec(color ?? "");
    expect(m, `light-mode color should be light: ${color}`).toBeTruthy();
    const [, r, g, b] = m!.map(Number) as unknown as number[];
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    expect(luminance).toBeGreaterThan(0.6);
  }
  await page.screenshot({ path: "test-results/probe-light.png" });
});

test("workbench credits chip shows balance and opens the recharge panel", async ({ page }) => {
  await mockGallery(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/generate/video");
  await page.waitForSelector(".wc-direct-credits-action", { timeout: 20_000 });
  await page.waitForTimeout(800);

  const chip = page.locator(".wc-direct-credits-action");
  await expect(chip).toContainText("88.5 积分");

  await chip.click();
  await expect(page.locator(".wc-account-backdrop")).toBeVisible();
  // 直达充值视图（而非默认会员页）
  await expect(page.locator(".wc-account-center-tabs")).toBeVisible();
});
