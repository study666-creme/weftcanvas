import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * 文档截图捕获：README/项目介绍的图库由这里生成。默认跳过，
 * 用 `CAPTURE_DOCS_SHOTS=1 npx playwright test e2e/docs-screenshots.capture.spec.ts`
 * 显式运行（公开树跑出的图品牌即纬线，直接可入 README）。
 * 产物写到 test-results/docs-shots/，人工挑选后放入 docs/screenshots/。
 */
const CAPTURE = process.env.CAPTURE_DOCS_SHOTS === "1";
const OUT_DIR = "test-results/docs-shots";

/**
 * 画布里的演示图：一张真实的人像样张（16:9）。
 *
 * 早先这里是 OffscreenCanvas 现画的"雨夜霓虹"——几个纯色霓虹块排成一排，缩放
 * 到节点里就是一张柱状图，用户点名说它丑（「仓库的画布截图里面那张柱状图演示图
 * 太丑了，一律换成图二」）。文档图讲的是"一句话生成人像"，就该放一张真的成片。
 */
const DEMO_MEDIA = {
  bytes: readFileSync(new URL("./docs-canvas-portrait.jpg", import.meta.url)),
  name: "portrait-soft-light.jpg",
  mimeType: "image/jpeg",
  width: 1280,
  height: 720,
};

/**
 * 文档图必须与真实部署解耦：目录与报价全部 mock。
 * 模型名用站内中性展示名（不出现上游原始模型名），并带简介与成功率，
 * 让 README 图正好展示「能量条 + 两行选项」这两个新能力。
 */
const CATALOG_VERSION = "docs-catalog-1";
function docsModel(
  id: string,
  label: string,
  modality: "image" | "video",
  description: string,
  priceYuan: number,
  unit: "image" | "second",
  health?: { successRate: number; sampleCount: number },
) {
  return {
    id,
    label,
    description,
    modality,
    operation: "generate",
    order: 0,
    input: { textRequired: true, images: { min: 0, max: 2, multiple: true } },
    output: { type: modality, minCount: 1, maxCount: 1 },
    parameters: [
      {
        name: "prompt",
        label: "提示词",
        type: "string",
        required: true,
        mutuallyExclusiveWith: [],
      },
      {
        name: "size",
        label: "尺寸",
        type: "string",
        options: ["1:1", "16:9", "9:16"],
        default: "16:9",
        mutuallyExclusiveWith: [],
      },
    ],
    pricing: {
      mode: "fixed",
      unit,
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: Math.round(priceYuan * 100 * 1e6),
      baseYuanMicros: Math.round(priceYuan * 1e6),
      tiers: [],
    },
    ...(health ? { health: { ...health, windowHours: 168 } } : {}),
  };
}
const DOCS_MODELS = [
  docsModel(
    "universal-25",
    "全能模型2.5 · 高质量",
    "image",
    "原生画质档，支持 1K/2K/4K 分辨率与多档质量",
    2.2,
    "image",
    { successRate: 0.95, sampleCount: 433 },
  ),
  docsModel(
    "universal-25-fast",
    "全能模型2.5 · 快速",
    "image",
    "同代快速档，出图更快、价格更低",
    1.2,
    "image",
    { successRate: 0.97, sampleCount: 812 },
  ),
  docsModel("banana-2", "香蕉 · 2代 1K/2K/4K", "image", "写实人像与场景细节见长", 0.22, "image", {
    successRate: 0.97,
    sampleCount: 812,
  }),
  docsModel(
    "banana-pro",
    "香蕉 · 专业 1K/2K/4K",
    "image",
    "高分辨率专业档，适合成品图",
    0.44,
    "image",
    { successRate: 0.61, sampleCount: 67 },
  ),
  docsModel(
    "s20-max",
    "S-2.0 满血 · 线路六",
    "video",
    "电影感运动与光影，12 秒内长镜头",
    1.6,
    "second",
    { successRate: 0.88, sampleCount: 291 },
  ),
  docsModel(
    "seedance-official",
    "Seedance 官方 · Fast",
    "video",
    "官方直连通道，语义遵循稳定",
    0.9,
    "second",
  ),
];

test.describe("docs screenshot capture", () => {
  test.skip(!CAPTURE, "run with CAPTURE_DOCS_SHOTS=1 to regenerate docs images");

  test.beforeEach(async ({ page }) => {
    mkdirSync(OUT_DIR, { recursive: true });
    await page.route("**/api/v1/auth/session", (route) =>
      route.fulfill({ json: { ok: true, data: null } }),
    );
    await page.route("**/api/v1/model-catalog**", (route) => {
      const requested = new URL(route.request().url()).searchParams.get("modality");
      const models = requested
        ? DOCS_MODELS.filter((model) => model.modality === requested)
        : DOCS_MODELS;
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      route.fulfill({
        json: {
          ok: true,
          data: {
            version: CATALOG_VERSION,
            capabilityVersion: "docs-capability-1",
            pricingVersion: "docs-pricing-1",
            fetchedAt: new Date().toISOString(),
            expiresAt,
            quoteAvailable: true,
            models,
          },
        },
      });
    });
    await page.route("**/api/v1/generation-quotes", async (route) => {
      const request = route.request().postDataJSON() as {
        modelId: string;
        modality: string;
        parameters: Record<string, unknown>;
      };
      const model = DOCS_MODELS.find((entry) => entry.id === request.modelId) ?? DOCS_MODELS[0]!;
      const yuan = (model.pricing.baseYuanMicros as number) / 1e6;
      route.fulfill({
        json: {
          ok: true,
          data: {
            id: "quote-docs-1",
            modelId: model.id,
            modelLabel: model.label,
            modality: model.modality,
            quantity: 1,
            outputCount: 1,
            normalizedParameters: request.parameters ?? {},
            creditMicros: Math.round(yuan * 100 * 1e6),
            credits: String((yuan * 100).toFixed(1)),
            yuanMicros: Math.round(yuan * 1e6),
            yuan: String(yuan),
            estimated: false,
            pricingUnit: model.pricing.unit,
            catalogVersion: CATALOG_VERSION,
            capabilityVersion: "docs-capability-1",
            pricingVersion: "docs-pricing-1",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          },
        },
      });
    });
  });

  async function seedCanvas(page: Page, theme: "light" | "dark") {
    await page.addInitScript((value) => {
      localStorage.setItem("weftcanvas:theme", value);
      localStorage.setItem("weftcanvas:theme-mode", "manual");
    }, theme);
    await page.addInitScript(
      async ({ base64, name, mimeType, width, height }) => {
        const now = Date.now();
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        const blob = new Blob([bytes], { type: mimeType });
        const media = {
          id: "docs-shot-image",
          name,
          mimeType,
          size: blob.size,
          width,
          height,
          durationMs: null,
          blob,
          storedAt: now,
        };
        await new Promise<void>((resolve, reject) => {
          const open = indexedDB.open("weftcanvas-media", 2);
          open.addEventListener("upgradeneeded", () => {
            const db = open.result;
            if (!db.objectStoreNames.contains("media"))
              db.createObjectStore("media", { keyPath: "id" });
            if (!db.objectStoreNames.contains("media-thumbs"))
              db.createObjectStore("media-thumbs", { keyPath: "id" });
          });
          open.addEventListener("success", () => {
            const db = open.result;
            const tx = db.transaction("media", "readwrite");
            tx.objectStore("media").put(media);
            tx.addEventListener("complete", () => resolve());
            tx.addEventListener("error", () => reject(tx.error));
          });
          open.addEventListener("error", () => reject(open.error));
        });
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
        const node = (
          id: string,
          kind: string,
          x: number,
          y: number,
          width: number,
          height: number,
          body: string,
          accent: string,
          mediaRef: unknown,
          config: unknown,
        ) => ({
          id,
          type: "weftcanvas",
          position: { x, y },
          width,
          height,
          selected: false,
          data: {
            kind,
            body,
            accent,
            status: "idle",
            progress: null,
            media: mediaRef,
            directorCapture: null,
            config,
            edit: null,
            music: null,
            uploading: undefined,
            generation,
            createdAt: now,
            updatedAt: now,
          },
        });
        const imageMedia = {
          id: media.id,
          name: media.name,
          mimeType: media.mimeType,
          size: media.size,
          source: "local",
          serverId: null,
          width: media.width,
          height: media.height,
          durationMs: null,
        };
        const project = {
          schemaVersion: 1,
          id: "docs-capture-canvas",
          name: "纬线 1",
          nodes: [
            node(
              "shot-prompt",
              "text",
              40,
              40,
              320,
              180,
              "一个绝世美人，改良服饰，亚洲面孔，暖调侧光，人像特写。",
              "jade",
              null,
              null,
            ),
            node("shot-config", "config", 40, 280, 320, 180, "", "jade", null, {
              modality: "image",
              aspectRatio: "16:9",
              resolution: "1k",
            }),
            node(
              "shot-image",
              "image",
              460,
              42,
              420,
              260,
              "16:9 · 人像特写 · 暖调侧光",
              "blue",
              imageMedia,
              null,
            ),
            node(
              "shot-video",
              "video",
              460,
              360,
              420,
              236,
              "8s · 慢推特写收尾",
              "violet",
              null,
              null,
            ),
          ],
          edges: [
            { id: "edge-prompt", source: "shot-prompt", target: "shot-image" },
            { id: "edge-config", source: "shot-config", target: "shot-image" },
            { id: "edge-chain", source: "shot-image", target: "shot-video" },
          ],
          groups: [],
          viewport: { x: 120, y: 90, zoom: 0.86 },
          createdAt: now,
          updatedAt: now,
        };
        localStorage.setItem(
          `weftcanvas:project-data:v1:${encodeURIComponent(project.id)}`,
          JSON.stringify(project),
        );
        localStorage.setItem(
          "weftcanvas:projects:v1",
          JSON.stringify({
            version: 1,
            projects: [
              {
                id: project.id,
                name: project.name,
                createdAt: now,
                updatedAt: now,
                nodeCount: project.nodes.length,
              },
            ],
          }),
        );
        localStorage.setItem("weftcanvas:active-project:v1", project.id);
      },
      {
        base64: DEMO_MEDIA.bytes.toString("base64"),
        name: DEMO_MEDIA.name,
        mimeType: DEMO_MEDIA.mimeType,
        width: DEMO_MEDIA.width,
        height: DEMO_MEDIA.height,
      },
    );
  }

  async function shot(page: Page, name: string) {
    await page.screenshot({ path: `${OUT_DIR}/${name}.png` });
  }

  async function openCanvas(page: Page, theme: "light" | "dark") {
    await seedCanvas(page, theme);
    await page.goto("/canvas");
    await expect(page.locator(".wc-workspace")).toBeVisible();
    const imageNode = page.locator('.react-flow__node[data-id="shot-image"]');
    await expect(imageNode).toBeVisible();
    await expect
      .poll(async () =>
        imageNode
          .locator("img")
          .evaluateAll((imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0)),
      )
      .toBe(true);
    // 让入场动画与呼吸动画稳定一拍再拍，避免糊。
    await page.waitForTimeout(900);
    return imageNode;
  }

  test("canvas light", async ({ page }) => {
    await openCanvas(page, "light");
    await shot(page, "canvas-light");
  });

  test("canvas dark", async ({ page }) => {
    await openCanvas(page, "dark");
    await shot(page, "canvas-dark");
  });

  test("generation panel + model picker", async ({ page }) => {
    const imageNode = await openCanvas(page, "light");
    await imageNode.click();
    await expect(page.locator(".wc-edit-dock, .wc-node-generation-panel").first()).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, "generation-panel");

    const picker = page.getByRole("button", { name: "模型" }).first();
    if (await picker.isVisible().catch(() => false)) {
      await picker.click();
      await page.waitForTimeout(400);
      await shot(page, "model-picker");
    }
  });

  test("asset library", async ({ page }) => {
    await openCanvas(page, "light");
    await page.getByRole("button", { name: "打开资源库" }).click();
    await expect(page.locator(".wc-resource-drawer")).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, "asset-library");
  });

  test("director stage", async ({ page }) => {
    await openCanvas(page, "dark");
    await page.getByRole("button", { name: "打开 3D 导演台" }).click();
    await page.waitForTimeout(1_600);
    await shot(page, "director-stage");
  });

  test("workbench light", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("weftcanvas:theme", "light");
      localStorage.setItem("weftcanvas:theme-mode", "manual");
    });
    await page.goto("/generate/image");
    await expect(page.locator("[data-direct-generation]")).toBeVisible();
    await page.waitForTimeout(900);
    await shot(page, "workbench-light");
  });

  test("workbench dark", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("weftcanvas:theme", "dark");
      localStorage.setItem("weftcanvas:theme-mode", "manual");
    });
    await page.goto("/generate/image");
    await expect(page.locator("[data-direct-generation]")).toBeVisible();
    await page.waitForTimeout(900);
    await shot(page, "workbench-dark");
  });

  test("byok settings dialog", async ({ page }) => {
    // BYOK 请求由浏览器直发上游：mock 一个 OpenAI 兼容站点的模型列表，
    // 让对话框呈现「已连接 + 拉到的模型」的真实形态，而不是错误态。
    // 带 CORS 头并应答 OPTIONS 预检——Authorization 头会触发预检，缺了它
    // 浏览器会拒绝响应，对话框就会出现「无法读取模型目录」的黄条。
    await page.route("https://api.byok.test/v1/models", (route) => {
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "authorization,content-type",
            "access-control-allow-methods": "GET,POST,OPTIONS",
          },
        });
      }
      return route.fulfill({
        json: {
          data: [
            { id: "nano-banana" },
            { id: "universal-image-2" },
            { id: "sora-video-mini" },
            { id: "speech-tts-v3" },
          ],
        },
        headers: { "access-control-allow-origin": "*" },
      });
    });
    await page.route("https://api.byok.test/api/model-catalog", (route) => {
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "authorization,content-type",
            "access-control-allow-methods": "GET,OPTIONS",
          },
        });
      }
      return route.fulfill({
        json: {
          success: true,
          version: "byok-demo-1",
          capability_version: "2026-10-14",
          fetched_at: new Date().toISOString(),
          models: [
            {
              id: "nano-banana",
              modality: "image",
              operation: "generate",
              endpoint: {
                method: "POST",
                path: "/v1/images/generations",
                content_type: "application/json",
              },
              output: { type: "image" },
              parameters: [],
              public: {
                id: "nano-banana",
                label: "香蕉 · 标准 1K",
                description: "写实人像与产品图",
              },
            },
            {
              id: "universal-image-2",
              modality: "image",
              operation: "generate",
              endpoint: {
                method: "POST",
                path: "/v1/images/generations",
                content_type: "application/json",
              },
              output: { type: "image" },
              parameters: [],
              public: {
                id: "universal-image-2",
                label: "全能模型2 · 高质量",
                description: "多档分辨率，细节丰富",
              },
            },
            {
              id: "sora-video-mini",
              modality: "video",
              operation: "generate",
              endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
              output: { type: "video" },
              parameters: [],
              public: {
                id: "sora-video-mini",
                label: "视频模型 Mini",
                description: "8 秒内短镜头",
              },
            },
            {
              id: "speech-tts-v3",
              modality: "text",
              operation: "generate",
              endpoint: {
                method: "POST",
                path: "/v1/chat/completions",
                content_type: "application/json",
              },
              output: { type: "text" },
              parameters: [],
              public: {
                id: "speech-tts-v3",
                label: "对话模型 V3",
                description: "长上下文文本生成",
              },
            },
          ],
        },
        headers: { "access-control-allow-origin": "*" },
      });
    });
    await openCanvas(page, "light");
    const profileId = await page.evaluate(async () => {
      const store = await import("/src/state/custom-api-store.ts");
      const id = store.useCustomApiStore.getState().addProfile({ name: "我的 OpenAI 兼容站" });
      // addProfile 只建档案；configureProfile 才真正走连接 + 拉模型。
      void store.useCustomApiStore.getState().configureProfile(id, {
        baseUrl: "https://api.byok.test/v1",
        apiKey: "sk-demo-key-0000",
        apiFormat: "openai",
      });
      store.useCustomApiStore.getState().openDialog();
      return id;
    });
    await expect(page.locator(".wc-custom-api-dialog")).toBeVisible();
    await expect
      .poll(
        async () =>
          page.evaluate(async (id) => {
            const store = await import("/src/state/custom-api-store.ts");
            const profile = store.useCustomApiStore.getState().profiles.find((p) => p.id === id);
            return profile?.status ?? "";
          }, profileId),
        { timeout: 5_000 },
      )
      .toBe("ready");
    await page.waitForTimeout(500);
    await shot(page, "byok-settings");
  });

  test("appearance styles", async ({ page }) => {
    await openCanvas(page, "light");
    await page.getByRole("button", { name: "打开 UI 设置" }).click();
    await expect(page.locator(".wc-appearance-toolbar")).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, "appearance-styles");
  });
});
