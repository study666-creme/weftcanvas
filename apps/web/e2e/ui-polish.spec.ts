import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.route("**/api/v1/model-catalog**", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "ui-polish-catalog",
        capabilityVersion: "ui-polish-capability",
        pricingVersion: "ui-polish-pricing",
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        quoteAvailable: false,
        models: [],
      },
    },
  }));
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 4_000 });
});

test("icon hints use the polished tooltip layer instead of the browser title bubble", async ({ page }, testInfo) => {
  const trigger = page.getByLabel("打开 UI 设置");
  await expect(trigger).toHaveAttribute("title", "UI 设置");
  await trigger.hover();

  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveClass(/is-visible/);
  await expect(tooltip).toHaveText("UI 设置");
  await expect(trigger).not.toHaveAttribute("title", /.+/);
  await expect(trigger).toHaveAttribute("aria-describedby", /kc-global-tooltip/);
  await expect(tooltip).toHaveCSS("border-radius", "4px");
  await page.screenshot({ path: testInfo.outputPath("polished-tooltip.png") });

  await page.mouse.move(900, 500);
  await expect(page.locator(".kc-global-tooltip")).not.toHaveClass(/is-visible/);
});

test("node material, background, and generation effect remain completely independent", async ({ page }) => {
  await page.getByLabel("打开 UI 设置").click();
  const settings = page.getByRole("dialog", { name: "UI 设置" });
  const materials = settings.getByRole("group", { name: "节点样式" });
  const backgrounds = settings.getByRole("group", { name: "背景样式" });
  const effects = settings.getByRole("group", { name: "生成动效" });

  await backgrounds.getByRole("button", { name: "星空", exact: true }).click();
  await effects.getByRole("button", { name: "水镜生成动效" }).click();
  await materials.getByRole("button", { name: "疏朗", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-canvas-style", "airy");
  await expect(page.locator(".kc-flow-shell")).toHaveAttribute("data-canvas-background", "starfield");
  await expect(page.locator("html")).toHaveAttribute("data-generation-effect", "water");

  await backgrounds.getByRole("button", { name: "水面", exact: true }).click();
  await materials.getByRole("button", { name: "无界", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-canvas-style", "studio");
  await expect(page.locator(".kc-flow-shell")).toHaveAttribute("data-canvas-background", "water");
  await expect(page.locator("html")).toHaveAttribute("data-generation-effect", "water");
});

test("water background stays still at idle and uses bounded parallax while the viewport is moving", async ({ page }) => {
  await page.getByLabel("打开 UI 设置").click();
  const settings = page.getByRole("dialog", { name: "UI 设置" });
  await settings.getByRole("group", { name: "背景样式" }).getByRole("button", { name: "水面", exact: true }).click();
  await page.getByLabel("收起 UI 设置").click();

  const workspace = page.locator(".kc-workspace");
  const waterLayer = page.getByTestId("canvas-water-surface").locator(".kc-canvas-water-material");
  await expect(waterLayer).toHaveCSS("animation-name", "none");
  const transformBeforePan = await waterLayer.evaluate((element) => getComputedStyle(element).transform);

  const pane = page.locator(".react-flow__pane");
  const bounds = await pane.boundingBox();
  expect(bounds).not.toBeNull();
  await page.keyboard.down("Space");
  await page.mouse.move(bounds!.x + bounds!.width * 0.72, bounds!.y + bounds!.height * 0.66);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.54, bounds!.y + bounds!.height * 0.52, { steps: 8 });
  await expect(workspace).toHaveClass(/is-viewport-moving/);
  await expect.poll(() => waterLayer.evaluate((element) => getComputedStyle(element).transform)).not.toBe(transformBeforePan);

  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect(workspace).not.toHaveClass(/is-viewport-moving/);
  await expect(waterLayer).toHaveCSS("animation-name", "none");
});
