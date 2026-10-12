import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: { ok: true, data: null },
    }),
  );
});

test("video models are grouped only by anonymous NewAPI route lines", async ({
  page,
}, testInfo) => {
  const now = Date.now();
  await page.route("**/api/v1/model-catalog", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          version: "video-route-catalog-1",
          capabilityVersion: "video-route-capability-1",
          pricingVersion: "video-route-pricing-1",
          fetchedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
          quoteAvailable: true,
          models: [
            videoModel("veo-3", "Veo 3", 2, 1, "内部渠道甲"),
            videoModel("sd-2-pro", "SD 2.0 Pro", 1, 1, "内部渠道甲"),
            videoModel("kling-2-6", "可灵 2.6", 1, 2, "内部渠道乙"),
            videoModel("grok-1-5", "Grok Imagine Video 1.5 Preview", 0, 2, "内部渠道乙"),
          ],
        },
      },
    }),
  );
  await page.route("**/api/v1/generation-quotes", async (route) => {
    const request = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ok: true,
        data: {
          id: "quote-video-compact-1",
          modelId: request.modelId,
          modelLabel: "Grok Imagine Video 1.5 Preview",
          modality: "video",
          quantity: 1,
          normalizedParameters: request.parameters,
          creditMicros: 17_000_000,
          credits: "17",
          yuanMicros: 170_000,
          yuan: "0.17",
          estimated: false,
          pricingUnit: "request",
          catalogVersion: "video-route-catalog-1",
          capabilityVersion: "video-route-capability-1",
          pricingVersion: "video-route-pricing-1",
          expiresAt: new Date(now + 60_000).toISOString(),
        },
      },
    });
  });
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/canvas");

  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("button", { name: "添加视频节点" })
    .click();
  const videoNode = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])')
    .last();
  await videoNode.locator(".wc-node-drag-strip").click();
  const settings = page.getByLabel("视频节点创作设置");
  await settings.hover();
  await settings.getByLabel("模型").click();

  const listbox = page.getByRole("listbox", { name: "模型" });
  await expect(listbox).toBeVisible();
  await expect(listbox.locator(".wc-canvas-select-group")).toHaveText(["线路一", "线路二"]);
  await expect(listbox.getByRole("option").locator(".wc-canvas-select-label")).toHaveText([
    "SD 2.0 Pro",
    "Veo 3",
    "Grok Imagine Video 1.5 Preview",
    "可灵 2.6",
  ]);
  await expect(listbox).not.toContainText("内部渠道甲");
  await expect(listbox).not.toContainText("内部渠道乙");
  await expect(listbox).not.toContainText("private.example.com");
  await page.screenshot({ path: testInfo.outputPath("video-route-lines.png") });

  await listbox
    .locator(".wc-canvas-select-label", { hasText: "Grok Imagine Video 1.5 Preview" })
    .click();
  await expect(settings.locator("[data-generation-model-select]")).toHaveValue("grok-1-5");
  await expect(settings.locator(".wc-generation-quick-controls small")).toHaveText([
    "画面比例",
    "时长（秒）",
    "分辨率",
  ]);
  await expect(
    settings.locator(".wc-generation-quick-controls .wc-canvas-select-label"),
  ).toHaveText(["16:9", "5 秒", "720p"]);
  const measureCompactLayout = () =>
    settings.locator(".wc-generation-compact-bar").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const controls = [
        ...element.querySelectorAll(
          [
            ".wc-generation-model-control",
            ".wc-generation-parameter-control",
            ".wc-generation-more-wrap",
            ".wc-generation-submit-area",
          ].join(", "),
        ),
      ].map((control) => ({
        name: control.getAttribute("title") || control.className,
        bounds: control.getBoundingClientRect(),
      }));
      const overlaps: string[] = [];
      for (let left = 0; left < controls.length; left += 1) {
        for (let right = left + 1; right < controls.length; right += 1) {
          const a = controls[left];
          const b = controls[right];
          if (!a || !b) continue;
          const horizontal =
            Math.min(a.bounds.right, b.bounds.right) - Math.max(a.bounds.left, b.bounds.left);
          const vertical =
            Math.min(a.bounds.bottom, b.bounds.bottom) - Math.max(a.bounds.top, b.bounds.top);
          if (horizontal > 1 && vertical > 1) overlaps.push(`${a.name} / ${b.name}`);
        }
      }
      const submit = element
        .querySelector(".wc-generation-submit--compact")
        ?.getBoundingClientRect();
      const quick = element.querySelector(".wc-generation-quick-controls");
      return {
        fits: element.scrollWidth <= element.clientWidth + 1,
        overflowX: getComputedStyle(element).overflowX,
        quickFits: quick ? quick.scrollWidth <= quick.clientWidth + 1 : false,
        quickOverflowX: quick ? getComputedStyle(quick).overflowX : "missing",
        submitInside: submit
          ? submit.left >= bounds.left - 1 && submit.right <= bounds.right + 1
          : false,
        clippedText: [
          ...element.querySelectorAll(
            [
              ".wc-generation-model-control .wc-canvas-select-label",
              ".wc-generation-quick-controls small",
              ".wc-generation-quick-controls .wc-canvas-select-label",
              ".wc-generation-compact-credit",
              ".wc-generation-submit--compact span",
            ].join(", "),
          ),
        ].flatMap((child) =>
          child.scrollWidth > child.clientWidth + 1
            ? [child.textContent?.trim() || child.className]
            : [],
        ),
        overlaps,
      };
    });

  for (const viewport of [
    { width: 1440, height: 900, name: "wide" },
    { width: 1024, height: 900, name: "desktop" },
    { width: 390, height: 844, name: "narrow" },
  ]) {
    await page.setViewportSize(viewport);
    await expect(settings).toBeVisible();
    expect(await measureCompactLayout()).toEqual({
      fits: true,
      overflowX: "visible",
      quickFits: true,
      quickOverflowX: "visible",
      submitInside: true,
      clippedText: [],
      overlaps: [],
    });
    await page.screenshot({
      path: testInfo.outputPath(`video-compact-generation-${viewport.name}.png`),
    });
  }
});

function videoModel(
  id: string,
  label: string,
  order: number,
  routeLine: number,
  channelName: string,
) {
  return {
    id,
    label,
    description: `${label} 视频生成`,
    modality: "video",
    operation: "video.generate",
    order,
    routeLine,
    input: { textRequired: true },
    output: { type: "video", minCount: 1, maxCount: 1 },
    parameters: [
      {
        name: "aspect_ratio",
        label: "画面比例",
        type: "string",
        required: false,
        default: "16:9",
        options: ["16:9", "9:16"],
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
        name: "resolution",
        label: "分辨率",
        type: "string",
        required: false,
        default: "720p",
        options: ["720p", "1080p"],
        mutuallyExclusiveWith: [],
      },
      {
        name: "camera_fixed",
        label: "固定镜头",
        type: "boolean",
        required: false,
        default: false,
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
    channelId: routeLine === 1 ? 481 : 927,
    channelName,
    upstreamHost: "private.example.com",
  };
}
