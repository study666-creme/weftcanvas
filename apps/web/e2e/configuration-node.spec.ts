import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.route("**/api/v1/model-catalog*", (route) => {
    const requestedModality = new URL(route.request().url()).searchParams.get("modality");
    const availableModalities = requestedModality
      ? [requestedModality]
      : ["image", "video", "audio", "text"];
    const now = new Date();
    const expires = new Date(now.getTime() + 60_000);
    return route.fulfill({
      json: {
        ok: true,
        data: {
          version: "catalog-test",
          capabilityVersion: "capability-test",
          pricingVersion: "pricing-test",
          fetchedAt: now.toISOString(),
          expiresAt: expires.toISOString(),
          quoteAvailable: true,
          models: availableModalities.map((modality) => ({
            id: `${modality}-model-test`,
            label: modality === "image" ? "sd2-431-720p-fast" : `${modality} 模型`,
            description: "测试模型",
            modality,
            operation: `${modality}.generate`,
            order: 1,
            input: { textRequired: true },
            output: { type: modality, minCount: 1, maxCount: 1 },
            parameters:
              modality === "video"
                ? [
                    {
                      name: "prompt",
                      label: "提示内容",
                      type: "string",
                      required: true,
                      mutuallyExclusiveWith: [],
                    },
                    {
                      name: "duration",
                      label: "时长（秒）",
                      type: "integer",
                      required: false,
                      default: 5,
                      options: [5, 10],
                      mutuallyExclusiveWith: [],
                    },
                    {
                      name: "aspect_ratio",
                      label: "画面比例",
                      type: "string",
                      required: false,
                      default: "16:9",
                      options: ["16:9", "21:9"],
                      mutuallyExclusiveWith: [],
                    },
                  ]
                : [
                    {
                      name: "prompt",
                      label: "提示内容",
                      type: "string",
                      required: true,
                      mutuallyExclusiveWith: [],
                    },
                    {
                      name: "aspect_ratio",
                      label: "画面比例",
                      type: "string",
                      required: false,
                      default: "1:1",
                      options: ["1:1", "16:9"],
                      mutuallyExclusiveWith: [],
                    },
                  ],
            pricing:
              modality === "video"
                ? {
                    mode: "tiered",
                    unit: "request",
                    currency: "CNY",
                    creditsPerYuan: 100,
                    baseCreditMicros: 200_000_000,
                    baseYuanMicros: 2_000_000,
                    tiers: [
                      { when: { duration: 5 }, creditMicros: 200_000_000, yuanMicros: 2_000_000 },
                      { when: { duration: 10 }, creditMicros: 400_000_000, yuanMicros: 4_000_000 },
                    ],
                  }
                : {
                    mode: "fixed",
                    unit: "request",
                    currency: "CNY",
                    creditsPerYuan: 100,
                    baseCreditMicros: 1_000_000,
                    baseYuanMicros: 10_000,
                    tiers: [],
                  },
          })),
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
    return route.fulfill({
      json: {
        ok: true,
        data: {
          id: "quote-test",
          modelId: request.modelId,
          modelLabel: "视觉模型",
          modality: request.modality,
          quantity: 1,
          normalizedParameters: request.parameters,
          creditMicros: 1_000_000,
          credits: "1",
          yuanMicros: 10_000,
          yuan: "0.01",
          estimated: false,
          pricingUnit: "request",
          catalogVersion: "catalog-test",
          capabilityVersion: "capability-test",
          pricingVersion: "pricing-test",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
  });
});

test("configuration node owns and synchronizes connected generation settings", async ({
  page,
}, testInfo) => {
  await page.goto("/canvas");
  const configNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="config"])',
  );
  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );

  await configNode.locator(".wc-node-drag-strip").click();
  const configPanel = page.getByLabel("配置节点参数");
  await expect(configPanel).toBeVisible();
  await expect(configPanel.locator("[data-generation-model-select]")).toHaveValue(
    "image-model-test",
  );
  await expect
    .poll(() => nodeGeometry(imageNode).then(({ width, height }) => width / height))
    .toBeCloseTo(1, 2);
  const squareGeometry = await nodeGeometry(imageNode);
  await configPanel.getByRole("button", { name: "画面比例" }).click();
  const aspectRatioMenu = page.getByRole("listbox", { name: "画面比例" });
  await expect(aspectRatioMenu).toBeVisible();
  await aspectRatioMenu.getByRole("option", { name: "16:9", exact: true }).click();
  await expect(aspectRatioMenu).toBeHidden();
  await expect
    .poll(() => nodeGeometry(imageNode).then(({ width, height }) => width / height))
    .toBeCloseTo(16 / 9, 2);
  const landscapeGeometry = await nodeGeometry(imageNode);
  expect(Math.max(landscapeGeometry.width, landscapeGeometry.height)).toBeCloseTo(
    Math.max(squareGeometry.width, squareGeometry.height),
    0,
  );
  expect(Math.abs(landscapeGeometry.centerX - squareGeometry.centerX)).toBeLessThan(2);
  expect(Math.abs(landscapeGeometry.centerY - squareGeometry.centerY)).toBeLessThan(2);
  await expect(page.locator(".wc-generation-backdrop")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("configuration-composer.png") });

  await expect(configNode.locator(".wc-config-node-preview")).toContainText("sd2-431-720p-fast");
  await expect(configNode.locator(".wc-config-node-preview")).toContainText("1 个节点");

  await imageNode.locator(".wc-node-drag-strip").click();
  const creationPanel = page.getByLabel("图片节点创作设置");
  await expect(creationPanel).toContainText("由配置节点同步");
  await expect(creationPanel.locator("[data-generation-model-select]")).toHaveValue(
    "image-model-test",
  );
  const compactModelLabel = creationPanel.locator(
    ".wc-generation-model-control .wc-canvas-select-label",
  );
  await expect(compactModelLabel).toHaveText("sd2-431-720p-fast");
  await expect(compactModelLabel).toHaveAttribute("title", "sd2-431-720p-fast");
  expect(
    await compactModelLabel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  expect(
    await creationPanel
      .locator(".wc-generation-compact-bar")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  expect(
    await creationPanel.locator(".wc-generation-quick-controls").evaluate((element) => ({
      fits: element.scrollWidth <= element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
    })),
  ).toEqual({ fits: true, overflowX: "visible" });
  await expect(
    creationPanel.getByRole("button", { name: "画面比例" }).locator(".wc-canvas-select-label"),
  ).toHaveText("16:9");

  await creationPanel
    .locator(".wc-generation-parameter-control")
    .filter({ hasText: "画面比例" })
    .locator("small")
    .click();
  const embeddedAspectRatioMenu = page.getByRole("listbox", { name: "画面比例" });
  await expect(embeddedAspectRatioMenu).toBeVisible();
  await embeddedAspectRatioMenu.getByRole("option", { name: "16:9", exact: true }).click();
  await expect(embeddedAspectRatioMenu).toBeHidden();
});

async function nodeGeometry(node: ReturnType<import("@playwright/test").Page["locator"]>) {
  return node.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height),
      centerX: bounds.x + bounds.width / 2,
      centerY: bounds.y + bounds.height / 2,
    };
  });
}

test("configuration model price follows selected parameters", async ({ page }) => {
  await page.goto("/canvas");
  const configNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="config"])',
  );

  await configNode.locator(".wc-node-drag-strip").click();
  const configPanel = page.getByLabel("配置节点参数");
  await configPanel.locator(".wc-config-modality button").nth(1).click();
  await expect(configPanel.locator("[data-generation-model-select]")).toHaveValue(
    "video-model-test",
  );

  const selectedModel = configPanel.locator(".wc-generation-model-picker").first();
  await expect(
    selectedModel.locator(".wc-canvas-select-trigger .wc-canvas-select-meta"),
  ).toHaveText("200 积分");

  await configPanel.getByRole("button", { name: "时长（秒）" }).click();
  const durationMenu = page.getByRole("listbox", { name: "时长（秒）" });
  await durationMenu.getByRole("option", { name: "10 秒", exact: true }).click();

  await expect(
    selectedModel.locator(".wc-canvas-select-trigger .wc-canvas-select-meta"),
  ).toHaveText("400 积分");
});
