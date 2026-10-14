import type { Page } from "@playwright/test";

import { expect, test } from "./zero-cost-test";

const originA = "https://images-a.example.test";
const originB = "https://images-b.example.test";
const apiKeyA = "sk-image-a-test-key";
const apiKeyB = "sk-image-b-test-key";
const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * 打开设置中心的「API 配置」板块。
 * 顶栏原先悬浮弹出的「创作设置」独立弹窗入口已下线：API 配置 / 模型 / 本地保存
 * 现在是设置中心的一级板块，这里统一从设置中心进入（返回设置面板定位器）。
 */
async function openCreationSettings(page: Page) {
  await page.getByLabel("打开设置").click();
  const panel = page.getByRole("dialog", { name: "设置" });
  await expect(panel).toBeVisible();
  await panel.getByRole("tab", { name: "API 配置" }).click();
  return panel;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.route("**/api/v1/model-catalog*", (route) =>
    route.fulfill({ json: platformCatalog() }),
  );
  await page.route("**/api/v1/generation-quotes", async (route) => {
    const request = route.request().postDataJSON() as {
      modelId: string;
      modality: string;
      parameters: Record<string, unknown>;
    };
    return route.fulfill({ json: quoteResponse(request) });
  });
  await mockProfile(page, originA);
  await mockProfile(page, originB);
});

test("creates additional API configurations from the settings surface", async ({ page }) => {
  await page.goto("/canvas");
  await openCreationSettings(page);

  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("还没有 API 配置");

  await dialog.locator(".wc-api-empty").getByRole("button", { name: "添加配置" }).click();
  // 公开/自托管构建没有预填站点：输入框为空、站点链接不渲染。
  await expect(dialog.getByLabel("服务地址")).toHaveValue("");
  await expect(dialog.getByRole("link", { name: "纬线 API" })).toHaveCount(0);

  await dialog.getByLabel("API Key", { exact: true }).fill("temporary-browser-key");
  await dialog.getByLabel("显示 API Key").click();
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveAttribute("type", "text");
  const enabledToggle = dialog.getByLabel("启用此 API 配置");
  await expect(enabledToggle).toBeChecked();
  await enabledToggle.uncheck();
  await expect(dialog.getByRole("button", { name: "配置已停用" })).toBeDisabled();
  await enabledToggle.check();
  await expect(dialog.getByRole("button", { name: "拉取模型" })).toBeDisabled();
  await dialog.getByLabel("服务地址").fill(originA);
  await expect(dialog.getByRole("button", { name: "拉取模型" })).toBeEnabled();
  await page.getByLabel("关闭设置").click();
  await openCreationSettings(page);
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveAttribute("type", "password");

  await dialog.getByLabel("添加 API 配置").click();
  await expect(dialog.locator(".wc-api-profile-list > button")).toHaveCount(2);
  await expect(dialog.getByLabel("配置名称")).toHaveValue("API 配置 2");
  await dialog.getByLabel("删除当前 API 配置").click();
  const confirmation = dialog.getByRole("alertdialog", { name: "确认删除 API 配置" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "取消" }).click();
  await expect(confirmation).toBeHidden();
  await dialog.getByLabel("删除当前 API 配置").click();
  await confirmation.getByRole("button", { name: "删除", exact: true }).click();
  await expect(dialog.locator(".wc-api-profile-list > button")).toHaveCount(1);
});

test("keeps actions on the single default accent while ready status stays semantic", async ({
  page,
}, testInfo) => {
  await page.goto("/canvas");

  // 配色档位已下线：全站只有一套强调色，<html> 上不再有 data-accent。
  await expect(page.locator("html")).not.toHaveAttribute("data-accent");

  await openCreationSettings(page);
  const dialog = page.getByRole("dialog", { name: "设置" });
  await addAndPullProfile(dialog, "图片 API A", originA, apiKeyA);

  // 强调色用探针比对计算值，避免把主题令牌的具体色值写死在规格里。
  const markColor = () =>
    dialog.evaluate((element) => {
      const probe = document.createElement("i");
      probe.style.color = "var(--wc-accent)";
      element.appendChild(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      const mark = element.querySelector(".wc-api-profile-icon");
      return { expected, actual: mark ? getComputedStyle(mark).color : null };
    });

  let colors = await markColor();
  expect(colors.actual).toBe(colors.expected);
  // 就绪状态是独立语义色，不跟随强调色。
  await expect(dialog.locator(".wc-api-profile-list > button > i.is-ready")).toHaveCSS(
    "background-color",
    "rgb(117, 170, 145)",
  );
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("creation-settings-default-dark.png") });

  await page.getByLabel("关闭设置").click();
  await page.getByLabel("切换主题").click();
  await openCreationSettings(page);
  colors = await markColor();
  expect(colors.actual).toBe(colors.expected);
  await page.screenshot({ path: testInfo.outputPath("creation-settings-default-light.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("creation-settings-default-mobile.png") });
});

test("merges built-in and multiple API models, honors visibility, and routes by profile", async ({
  page,
}, testInfo) => {
  const requestsA: Array<Record<string, unknown>> = [];
  const requestsB: Array<Record<string, unknown>> = [];
  let releaseGeneration!: () => void;
  const generationGate = new Promise<void>((resolve) => {
    releaseGeneration = resolve;
  });
  await page.route(`${originA}/v1/images/generations`, (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${apiKeyA}`);
    requestsA.push(route.request().postDataJSON());
    return route.fulfill({ json: { data: [{ b64_json: pixel }] } });
  });
  await page.route(`${originB}/v1/images/generations`, (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${apiKeyB}`);
    requestsB.push(route.request().postDataJSON());
    return generationGate.then(() => route.fulfill({ json: { data: [{ b64_json: pixel }] } }));
  });

  await page.goto("/canvas");
  await openCreationSettings(page);
  const dialog = page.getByRole("dialog", { name: "设置" });

  await addAndPullProfile(dialog, "图片 API A", originA, apiKeyA);
  await dialog.getByLabel("添加 API 配置").click();
  await fillAndPullActiveProfile(dialog, "图片 API B", originB, apiKeyB);
  // API 就绪状态改为设置按钮上的小圆点 + title 提示（原悬浮弹层已下线）
  await expect(page.locator(".wc-topbar-settings-trigger")).toHaveAttribute(
    "title",
    "设置 · 2 个自有 API 已就绪",
  );
  await expect(page.locator(".wc-topbar-settings-trigger .wc-api-indicator")).toHaveCount(1);

  await dialog.getByRole("tab", { name: "模型", exact: true }).click();
  const builtinSection = dialog.locator(".wc-model-source-section").filter({ hasText: "内置模型" });
  const profileASection = dialog
    .locator(".wc-model-source-section")
    .filter({ hasText: "图片 API A" });
  const profileBSection = dialog
    .locator(".wc-model-source-section")
    .filter({ hasText: "图片 API B" });
  await expect(builtinSection).toContainText("内置图片");
  await expect(profileASection).toContainText("创作图片");
  await expect(profileBSection).toContainText("创作图片");

  await builtinSection.locator("label").filter({ hasText: "内置图片" }).click();
  await profileASection.locator("label").filter({ hasText: "创作图片" }).click();
  await expect(builtinSection.getByRole("checkbox")).not.toBeChecked();
  await expect(profileASection.getByRole("checkbox")).not.toBeChecked();
  await expect(profileBSection.getByRole("checkbox")).toBeChecked();

  await Promise.all([
    page.waitForResponse(`${originA}/v1/models`),
    page.waitForResponse(`${originB}/v1/models`),
    dialog.getByRole("button", { name: "拉取全部 API 模型" }).click(),
  ]);
  await expect(dialog.locator(".wc-model-source-section .is-spinning")).toHaveCount(0);
  await expect(profileASection.getByRole("checkbox")).not.toBeChecked();
  await expect(profileBSection.getByRole("checkbox")).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("model-settings-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("model-settings-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("关闭设置").click();

  const creation = page.getByRole("navigation", { name: "创建工具" });
  await creation.locator(".wc-create-rail-plus-wrapper").hover();
  await creation.getByRole("menuitem", { name: "添加文本节点" }).click();
  const textNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  await textNode.locator(".wc-node-drag-strip").click();
  await expect(
    page.locator("[data-node-prompt-composer] [data-generation-model-select]"),
  ).toHaveCount(0);

  const imageNode = await createImageNode(page);
  await imageNode.locator(".wc-node-drag-strip").click();
  const panel = page.getByLabel("图片节点创作设置");
  await expect(panel.getByRole("button", { name: "模型", exact: true })).toContainText(
    "图片 API B",
  );
  await panel.getByRole("button", { name: "模型", exact: true }).click();
  const modelMenu = page.getByRole("listbox", { name: "模型" });
  await expect(modelMenu.getByRole("option")).toHaveCount(1);
  await expect(modelMenu).toContainText("创作图片 · 图片 API B");
  await expect(modelMenu).not.toContainText("图片 API A");
  await expect(modelMenu).not.toContainText("内置图片");
  await modelMenu.getByRole("option").click();

  const imageNodeId = await imageNode.getAttribute("data-id");
  expect(imageNodeId).toBeTruthy();
  const prompt = page.getByLabel("图片节点提示词");
  await prompt.fill("history baseline");
  await prompt.blur();
  await prompt.fill("雨夜站台，电影感构图");
  await panel.getByRole("button", { name: "生成", exact: true }).click();
  await expect.poll(() => requestsB).toHaveLength(1);
  await expect(imageNode.locator(".wc-node-loading")).toHaveAttribute(
    "data-generation-stage",
    "running",
  );
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+Z");
  await expect(imageNode.locator(".wc-node-loading")).toHaveAttribute(
    "data-generation-stage",
    "running",
  );
  releaseGeneration();
  await expect(imageNode.locator("img")).toBeVisible();
  await page.keyboard.press("Control+Y");
  await expect(imageNode.locator("img")).toBeVisible();
  await page.keyboard.press("Control+Z");
  await expect(imageNode.locator("img")).toBeVisible();
  expect(requestsA).toHaveLength(0);
  expect(requestsB).toHaveLength(1);
  expect(requestsB[0]).toMatchObject({ model: "image-model" });
  expect(String(requestsB[0]?.prompt)).toContain("雨夜站台，电影感构图");
});

test("writes new browser-owned images only to the selected image directory", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async ({ id }: { id?: string } = {}) => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(id ?? "weftcanvas-output", { create: true });
      },
    });
  });
  await page.route(`${originB}/v1/images/generations`, (route) =>
    route.fulfill({ json: { data: [{ b64_json: pixel }] } }),
  );

  await page.goto("/canvas");
  await openCreationSettings(page);
  const dialog = page.getByRole("dialog", { name: "设置" });
  await addAndPullProfile(dialog, "本地图片 API", originB, apiKeyB);

  await dialog.getByRole("tab", { name: "本地保存", exact: true }).click();
  const imageTarget = dialog.getByLabel("图片本地保存");
  const videoTarget = dialog.getByLabel("视频本地保存");
  await imageTarget.getByRole("button", { name: "选择图片保存目录" }).click();
  await videoTarget.getByRole("button", { name: "选择视频保存目录" }).click();
  await expect(imageTarget).toContainText("weftcanvas-generated-image");
  await expect(videoTarget).toContainText("weftcanvas-generated-video");
  await page.screenshot({ path: testInfo.outputPath("local-output-settings.png") });
  await page.getByLabel("关闭设置").click();

  const imageNode = await createImageNode(page);
  await imageNode.locator(".wc-node-drag-strip").click();
  const panel = page.getByLabel("图片节点创作设置");
  await panel.getByRole("button", { name: "模型", exact: true }).click();
  await page
    .getByRole("listbox", { name: "模型" })
    .getByRole("option")
    .filter({ hasText: "本地图片 API" })
    .click();
  await page.getByLabel("图片节点提示词").fill("保存到本地目录");
  await panel.getByRole("button", { name: "生成", exact: true }).click();
  await expect(imageNode.locator("img")).toBeVisible();

  await expect.poll(() => directoryFiles(page, "weftcanvas-generated-image")).toHaveLength(1);
  expect((await directoryFiles(page, "weftcanvas-generated-image"))[0]).toMatch(/\.png$/);
  expect(await directoryFiles(page, "weftcanvas-generated-video")).toEqual([]);
});

test("shows custom models after built-in options and submits an image without a reference", async ({
  page,
}) => {
  await page.route(`${originA}/api/model-catalog`, (route) =>
    route.fulfill({ json: genericImageCatalog() }),
  );
  await page.route(`${originA}/v1/images/generations`, (route) =>
    route.fulfill({ json: { data: [{ b64_json: pixel }] } }),
  );

  await page.goto("/canvas");
  await openCreationSettings(page);
  const dialog = page.getByRole("dialog", { name: "设置" });
  await addAndPullProfile(dialog, "通用图片 API", originA, apiKeyA);
  await page.getByLabel("关闭设置").click();

  const imageNode = await createImageNode(page);
  await imageNode.locator(".wc-node-drag-strip").click();
  const panel = page.getByLabel("图片节点创作设置");
  await panel.getByRole("button", { name: "模型", exact: true }).click();
  const modelMenu = page.getByRole("listbox", { name: "模型" });
  await expect(modelMenu.getByRole("option").filter({ hasText: "通用图片 API" })).toHaveCount(1);
  await expect(modelMenu.getByRole("option").last()).toContainText("通用图片 API");
  await modelMenu.getByRole("option").filter({ hasText: "通用图片 API" }).click();

  await page.getByLabel("图片节点提示词").fill("无需参考图的文生图");
  await panel.getByRole("button", { name: "生成", exact: true }).click();
  await expect(imageNode.locator("img")).toBeVisible();
});

test("blocks an image model that explicitly requires a reference image when none is attached", async ({
  page,
}) => {
  let generationRequests = 0;
  await page.route(`${originA}/api/model-catalog`, (route) =>
    route.fulfill({ json: requiredReferenceCatalog() }),
  );
  await page.route(`${originA}/v1/images/generations`, (route) => {
    generationRequests += 1;
    return route.fulfill({ json: { data: [{ b64_json: pixel }] } });
  });

  await page.goto("/canvas");
  await openCreationSettings(page);
  const dialog = page.getByRole("dialog", { name: "设置" });
  await addAndPullProfile(dialog, "参考图片 API", originA, apiKeyA);
  await page.getByLabel("关闭设置").click();

  const imageNode = await createImageNode(page);
  await imageNode.locator(".wc-node-drag-strip").click();
  const panel = page.getByLabel("图片节点创作设置");
  await panel.getByRole("button", { name: "模型", exact: true }).click();
  const modelMenu = page.getByRole("listbox", { name: "模型" });
  await expect(modelMenu.getByRole("option").filter({ hasText: "参考图片 API" })).toHaveCount(1);
  await modelMenu.getByRole("option").filter({ hasText: "参考图片 API" }).click();

  await page.getByLabel("图片节点提示词").fill("缺少参考图的生成");
  await expect(panel.getByRole("alert")).toContainText("参考图至少需要 1 张");
  await expect(panel.getByRole("button", { name: "生成", exact: true })).toBeDisabled();
  expect(generationRequests).toBe(0);
});

async function addAndPullProfile(
  dialog: ReturnType<Page["getByRole"]>,
  name: string,
  origin: string,
  apiKey: string,
) {
  await dialog.locator(".wc-api-empty").getByRole("button", { name: "添加配置" }).click();
  await fillAndPullActiveProfile(dialog, name, origin, apiKey);
}

async function createImageNode(page: Page) {
  const creation = page.getByRole("navigation", { name: "创建工具" });
  await creation.locator(".wc-create-rail-plus-wrapper").hover();
  await creation.getByRole("menuitem", { name: "添加图片节点" }).click();
  return page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])')
    .first();
}

async function fillAndPullActiveProfile(
  dialog: ReturnType<Page["getByRole"]>,
  name: string,
  origin: string,
  apiKey: string,
) {
  await dialog.getByLabel("配置名称").fill(name);
  await dialog.getByLabel("服务地址").fill(origin);
  await dialog.getByLabel("API Key", { exact: true }).fill(apiKey);
  await dialog.getByRole("button", { name: "拉取模型", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "重新拉取", exact: true })).toBeVisible();
}

async function mockProfile(page: Page, origin: string) {
  await page.route(`${origin}/api/model-catalog`, (route) =>
    route.fulfill({ json: sourceCatalog() }),
  );
  await page.route(`${origin}/v1/models`, (route) =>
    route.fulfill({ json: { object: "list", data: [{ id: "image-model" }] } }),
  );
}

function sourceCatalog() {
  return {
    success: true,
    version: "custom-catalog-1",
    capability_version: "custom-capability-1",
    pricing_version: "custom-pricing-1",
    fetched_at: new Date().toISOString(),
    models: [
      {
        id: "image-model",
        modality: "image",
        operation: "generate",
        order: 1,
        endpoint: {
          method: "POST",
          path: "/v1/images/generations",
          content_type: "application/json",
        },
        input: { text: { required: true } },
        output: { type: "image", count: { fixed: 1 } },
        parameters: [
          { name: "model", type: "string", fixed: "image-model" },
          { name: "prompt", label: "提示词", type: "string", required: true },
        ],
        public: { id: "image-model", label: "创作图片" },
        selectable: true,
      },
    ],
  };
}

function genericImageCatalog() {
  const source = sourceCatalog();
  source.models[0]!.parameters.push({
    name: "image",
    type: "string",
    required: true,
    format: "uri-or-data-image",
  });
  return source;
}

function requiredReferenceCatalog() {
  const source = sourceCatalog();
  source.models[0]!.parameters.push({
    name: "reference_image",
    type: "string",
    required: true,
    format: "uri-or-data-image",
  });
  return source;
}

function platformCatalog() {
  const now = new Date();
  return {
    ok: true,
    data: {
      version: "platform-1",
      capabilityVersion: "platform-capability-1",
      pricingVersion: "platform-pricing-1",
      fetchedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      quoteAvailable: true,
      models: [
        {
          id: "image-model",
          label: "内置图片",
          description: "内置图片模型",
          modality: "image",
          operation: "generate",
          order: 1,
          input: { textRequired: true },
          output: { type: "image", minCount: 1, maxCount: 1 },
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
            unit: "request",
            currency: "CNY",
            creditsPerYuan: 100,
            baseCreditMicros: 1_000_000,
            baseYuanMicros: 10_000,
            tiers: [],
          },
        },
      ],
    },
  };
}

function quoteResponse(request: {
  modelId: string;
  modality: string;
  parameters: Record<string, unknown>;
}) {
  return {
    ok: true,
    data: {
      id: "quote-test",
      modelId: request.modelId,
      modelLabel: "内置图片",
      modality: request.modality,
      quantity: 1,
      normalizedParameters: request.parameters,
      creditMicros: 1_000_000,
      credits: "1",
      yuanMicros: 10_000,
      yuan: "0.01",
      estimated: false,
      pricingUnit: "request",
      catalogVersion: "platform-1",
      capabilityVersion: "platform-capability-1",
      pricingVersion: "platform-pricing-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

async function directoryFiles(page: Page, name: string) {
  return page.evaluate(async (directoryName) => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(directoryName);
    const files: string[] = [];
    for await (const [fileName] of (
      directory as FileSystemDirectoryHandle & {
        entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries())
      files.push(fileName);
    return files.sort();
  }, name);
}
