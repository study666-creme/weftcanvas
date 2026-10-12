import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

import { seedStarterCanvas } from "./starter-canvas.fixture";

const videoFixture = fileURLToPath(new URL("./video-frame.mp4", import.meta.url));

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
});

test("captures the main desktop visual states", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.clear());
  await seedStarterCanvas(page);
  await page.goto("/canvas");

  await expect(page.locator(".wc-app")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await expect(page.locator(".react-flow__background-pattern.dots")).toHaveCount(1);
  await expect(page.locator(".react-flow__background-pattern.lines")).toHaveCount(1);
  await expect(page.locator(".react-flow__background-pattern.cross")).toHaveCount(0);
  const nodeMaterial = await page
    .locator(".wc-node-wrap--text .wc-node-surface")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderColor: style.borderTopColor,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
      };
    });
  // Default ("studio") node material: quiet rim + shallow inner light keep
  // empty media nodes findable on a dark canvas (see styles.css studio block).
  expect(nodeMaterial.borderColor).toBe("rgba(235, 240, 237, 0.21)");
  expect(nodeMaterial.borderRadius).toBe("7px");
  expect(nodeMaterial.boxShadow).not.toBe("none");
  expect(nodeMaterial.boxShadow).toContain("0px 0px 0px 1px");
  await page.screenshot({ path: testInfo.outputPath("canvas-dark.png") });
  await page.getByLabel("显示小地图").click();
  await expect(page.getByLabel("画布小地图")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("minimap-dark.png") });
  await page.getByLabel("画布快捷键").click();
  await expect(page.getByRole("dialog", { name: "画布快捷键" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("shortcuts-dark.png") });
  await page.getByLabel("关闭快捷键说明").click();
  await page.getByLabel("隐藏小地图").click();
  await page.getByLabel("项目菜单").click();
  await expect(page.locator(".wc-project-sidebar")).toBeVisible();
  await page.waitForTimeout(240);
  await page.screenshot({ path: testInfo.outputPath("project-sidebar-dark.png") });
  await page.getByLabel("关闭项目栏").click();

  const preview = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#171b1c";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#59646a";
    context.fillRect(0, 330, canvas.width, 210);
    context.fillStyle = "#c4b79c";
    context.fillRect(590, 80, 170, 300);
    context.fillStyle = "#788c87";
    context.fillRect(120, 130, 300, 210);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  await imageNode.locator('input[type="file"]').setInputFiles({
    name: "visual-check.png",
    mimeType: "image/png",
    buffer: Buffer.from(preview, "base64"),
  });
  await expect(imageNode.locator("img")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("media-full-bleed-dark.png") });

  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("button", { name: "添加视频节点" })
    .click();
  const videoNode = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])')
    .last();
  await videoNode.locator('input[type="file"]').setInputFiles(videoFixture);
  await expect(videoNode.getByLabel("视频进度")).toBeVisible();
  await videoNode.scrollIntoViewIfNeeded();
  await page.waitForTimeout(180);
  await page.screenshot({ path: testInfo.outputPath("media-cinema-dark.png") });

  const textNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  await textNode.locator(".wc-node-drag-strip").click();
  await expect(page.locator(".wc-node-action-toolbar")).toBeVisible();
  await page.waitForTimeout(320);
  await page.screenshot({ path: testInfo.outputPath("selected-dark.png") });

  await textNode.locator(".wc-node-port-zone--right .wc-node-port-core").click();
  await expect(textNode.locator(".wc-node-quick-add")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("quick-add-dark.png") });

  await page.getByLabel("切换主题").click();
  await expect(page.locator(".wc-app")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.waitForTimeout(180);
  await page.screenshot({ path: testInfo.outputPath("canvas-light.png") });
  await page.getByLabel("项目菜单").click();
  await expect(page.locator(".wc-project-sidebar")).toBeVisible();
  await page.waitForTimeout(240);
  await page.screenshot({ path: testInfo.outputPath("project-sidebar-light.png") });
  await page.getByLabel("关闭项目栏").click();

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator(".wc-app")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await page.waitForTimeout(320);
  await page.screenshot({ path: testInfo.outputPath("canvas-dark-1920.png") });
});

test("canvas visual presets switch, persist, and keep graph geometry stable", async ({
  page,
}, testInfo) => {
  await seedStarterCanvas(page);
  await page.goto("/canvas");

  const app = page.locator(".wc-app");
  const nodes = page.locator(".react-flow__node-weftcanvas");
  await expect(nodes.first()).toBeVisible();
  const initialNodeCount = await nodes.count();
  const initialBounds = await nodes.first().boundingBox();
  expect(initialBounds).not.toBeNull();
  await expect(app).toHaveAttribute("data-canvas-style", "studio");
  await expect(page.locator("html")).toHaveAttribute("data-canvas-style", "studio");

  await page.getByLabel("打开 UI 设置").click();
  const styleGroup = page.getByRole("group", { name: "节点样式" });
  await styleGroup.getByRole("button", { name: "无界", exact: true }).click();
  await expect(app).toHaveAttribute("data-canvas-style", "studio");
  await styleGroup.getByRole("button", { name: "经典", exact: true }).click();
  await expect(app).toHaveAttribute("data-canvas-style", "classic");
  await expect(nodes).toHaveCount(initialNodeCount);
  const classicRadius = await page
    .locator(".wc-node-surface")
    .first()
    .evaluate((element) => getComputedStyle(element).borderRadius);
  expect(classicRadius).toBe("10px");
  const classicBounds = await nodes.first().boundingBox();
  expect(classicBounds?.width).toBeCloseTo(initialBounds!.width, 0);
  expect(classicBounds?.height).toBeCloseTo(initialBounds!.height, 0);
  await page.getByLabel("收起 UI 设置").click();
  await page.waitForTimeout(220);
  await page.screenshot({ path: testInfo.outputPath("canvas-classic-dark.png") });
  await page.getByLabel("切换主题").click();
  await expect(app).toHaveAttribute("data-theme", "light");
  await page.waitForTimeout(220);
  await page.screenshot({ path: testInfo.outputPath("canvas-classic-light.png") });
  await page.getByLabel("切换主题").click();
  await expect(app).toHaveAttribute("data-theme", "dark");
  await page.waitForTimeout(220);

  await page.reload();
  await expect(app).toHaveAttribute("data-canvas-style", "classic");
  await page.getByLabel("打开 UI 设置").click();
  await page
    .getByRole("group", { name: "节点样式" })
    .getByRole("button", { name: "无界", exact: true })
    .click();
  await expect(app).toHaveAttribute("data-canvas-style", "studio");
  await page.getByLabel("收起 UI 设置").click();
  await page.waitForTimeout(220);
  await page.screenshot({ path: testInfo.outputPath("canvas-studio-dark.png") });
});
