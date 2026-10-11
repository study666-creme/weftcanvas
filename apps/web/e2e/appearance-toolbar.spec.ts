import { expect, test } from "./zero-cost-test";
import { seedStarterCanvas } from "./starter-canvas.fixture";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.goto("/canvas");
  await page.evaluate(() => localStorage.clear());
  await seedStarterCanvas(page);
  await page.reload();
});

test("UI settings separate visual previews from interaction preferences and persist choices", async ({ page }, testInfo) => {
  const dock = page.getByRole("navigation", { name: "编辑工具" });
  await expect(dock.getByLabel("组合选中节点")).toHaveCount(0);

  await dock.getByLabel("打开 UI 设置").click();
  const settings = page.getByRole("dialog", { name: "UI 设置" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("tab")).toHaveCount(2);
  await expect(settings.getByRole("group")).toHaveCount(6);
  const settingsBounds = await settings.boundingBox();
  expect(settingsBounds).not.toBeNull();
  expect(settingsBounds!.height).toBeGreaterThan(280);
  await expect(settings.getByRole("group", { name: "新建媒体节点默认画幅" })).toBeVisible();
  await expect(settings.getByRole("group", { name: "节点样式" }).getByRole("button")).toHaveCount(4);
  await expect(settings.getByRole("group", { name: "界面与功能栏样式" }).getByRole("button")).toHaveCount(3);
  await expect(settings.getByRole("button", { name: "深空", exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "灵境", exact: true })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-canvas-style", "airy");
  await expect(page.locator("html")).toHaveAttribute("data-node-style", "airy");
  await expect(page.locator("html")).toHaveAttribute("data-chrome-style", "airy");
  await expect(page.locator("html")).toHaveAttribute("data-edge-path-style", "taut");
  await expect(page.locator("html")).toHaveAttribute("data-edge-flow-style", "stream");
  await expect(page.locator(".kc-flow-shell")).toHaveAttribute("data-canvas-background", "layered-grid");
  await expect(page.locator('[data-node-port-style="classic"]')).not.toHaveCount(0);
  await expect(settings.locator('button[aria-pressed="true"]:visible')).toHaveCount(6);

  const effectChoices = settings.locator(".kc-generation-effect-choice");
  await expect(effectChoices).toHaveCount(4);
  await expect(effectChoices.nth(0).locator(".is-primary")).toHaveCSS("animation-name", "kc-preview-beam");
  await expect(effectChoices.nth(1).locator(".is-primary")).toHaveCSS("animation-name", "kc-preview-nebula");
  await expect(effectChoices.nth(2).locator(".is-primary")).toHaveCSS("animation-name", "kc-preview-water");
  await expect(effectChoices.nth(3).locator(".is-primary")).toHaveCSS("animation-name", "none");
  await expect.poll(() => effectChoices.nth(3).locator(".is-primary").evaluate((element) => getComputedStyle(element, "::after").animationName)).toBe("kc-preview-quiet");
  const previewProgress = effectChoices.nth(0).locator(".kc-generation-effect-preview-progress > span");
  const previewProgressBefore = await previewProgress.evaluate((element) => getComputedStyle(element).transform);
  await expect.poll(() => previewProgress.evaluate((element) => getComputedStyle(element).transform)).not.toBe(previewProgressBefore);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(effectChoices.nth(0).locator(".is-primary")).toHaveCSS("animation-name", "kc-preview-beam");
  await expect(effectChoices.nth(1).locator(".is-primary")).toHaveCSS("animation-name", "kc-preview-nebula");
  await expect(effectChoices.nth(2).locator(".is-primary")).toHaveCSS("animation-name", "kc-preview-water");
  await expect(effectChoices.nth(3).locator(".is-primary")).toHaveCSS("animation-name", "none");
  await expect.poll(() => effectChoices.nth(3).locator(".is-primary").evaluate((element) => getComputedStyle(element, "::after").animationName)).toBe("kc-preview-quiet");
  await expect(previewProgress).toHaveCSS("animation-iteration-count", "infinite");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // The retired 主题配色 group must be gone entirely: no role=group, no
  // data-accent attribute anywhere on the root element.
  await expect(settings.getByRole("group", { name: "主题配色" })).toHaveCount(0);
  await expect(settings.getByRole("group", { name: "配色方案" }).getByRole("button")).toHaveText(["石墨", "墨黑"]);
  await expect(page.locator("html")).not.toHaveAttribute("data-accent");
  await expect(page.locator(".kc-app")).not.toHaveAttribute("data-accent");
  await page.screenshot({ path: testInfo.outputPath("appearance-toolbar-airy.png") });

  const defaultAspect = settings.getByRole("group", { name: "新建媒体节点默认画幅" });
  await expect(defaultAspect.getByRole("button")).toHaveCount(5);
  await defaultAspect.getByRole("button", { name: "3:4", exact: true }).click();
  await expect(defaultAspect.getByRole("button", { name: "3:4", exact: true })).toHaveAttribute("aria-pressed", "true");

  await settings.getByRole("tab", { name: "交互" }).click();
  await expect(settings.getByRole("group")).toHaveCount(3);
  await expect(settings.getByRole("group", { name: "鼠标样式" })).toHaveCount(0);
  await settings.getByRole("group", { name: "连线形态" }).getByRole("button", { name: "柔弧" }).click();
  await settings.getByRole("group", { name: "连线光效" }).getByRole("button", { name: "星点" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-edge-path-style", "gravity");
  await expect(page.locator("html")).toHaveAttribute("data-edge-flow-style", "stardust");

  // The self-drawn cursor is gone: the native cursor stays visible, and the
  // one-shot PointerFeedback ring replaces it as the interaction cue.
  const pulse = page.getByTestId("pointer-pulse");
  await expect(pulse).toHaveCount(1);
  await expect(pulse).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("html")).not.toHaveAttribute("data-cursor-style");
  expect(await page.evaluate(() => document.documentElement.classList.contains("has-kc-cursor"))).toBe(false);
  expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).not.toBe("none");
  const pulseClassAfterPress = await page.evaluate(() => {
    const ring = document.querySelector<HTMLElement>('[data-testid="pointer-pulse"]')!;
    const node = document.querySelector<HTMLElement>(".react-flow__node-kachang")!;
    node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100 }));
    const className = ring.className;
    node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 100, clientY: 100 }));
    return className;
  });
  expect(pulseClassAfterPress).toContain("is-press");

  const textNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="text"])');
  await textNode.locator(".kc-node-drag-strip").click();
  const activeEdge = page.locator(".kc-edge-effect--stardust").first();
  const softCurveEdge = page.locator(".kc-edge-renderer.is-soft-curve:has(.kc-edge-effect--stardust)").first();
  await expect(activeEdge).toBeVisible();
  await expect(page.locator(".kc-edge-effect--stream")).toHaveCount(0);
  await expect(page.locator(".kc-edge-gravity-depth")).toHaveCount(0);
  await expect(activeEdge.locator(".kc-edge-star-field")).toHaveCount(1);
  await expect(activeEdge.locator(".kc-edge-star-inbound")).toHaveCount(2);
  await expect(activeEdge.locator(".kc-edge-star-focus-ring")).toHaveCount(1);
  await expect(activeEdge.locator(".kc-edge-star-focus-core")).toHaveCount(1);
  await expect(activeEdge.locator(".kc-edge-star-inbound").first()).toHaveCSS("filter", "none");
  await expect(activeEdge.locator(".kc-edge-star-inbound").first()).toHaveCSS("animation-name", "kc-edge-star-gather");
  const softCurveGeometry = await softCurveEdge.evaluate((element) => {
    const path = element.querySelector<SVGPathElement>(".react-flow__edge-path")!;
    const focus = element.querySelector<SVGCircleElement>(".kc-edge-star-focus-core")!;
    const length = path.getTotalLength();
    const start = path.getPointAtLength(0);
    const end = path.getPointAtLength(length);
    return {
      baselineY: (start.y + end.y) / 2,
      focusY: Number(focus.getAttribute("cy")),
      cubicSegments: (path.getAttribute("d")?.match(/C/g) ?? []).length,
    };
  });
  expect(softCurveGeometry.cubicSegments).toBe(1);
  expect(Math.abs(softCurveGeometry.focusY - softCurveGeometry.baselineY)).toBeLessThan(0.1);
  const inbound = activeEdge.locator(".kc-edge-star-inbound");
  const inboundPaths = await inbound.evaluateAll((elements) => elements.map((element) => element.getAttribute("d")));
  expect(inboundPaths[0]).not.toBe(inboundPaths[1]);
  const sourceOffset = await inbound.first().evaluate((element) => getComputedStyle(element).strokeDashoffset);
  await expect.poll(() => inbound.first().evaluate((element) => getComputedStyle(element).strokeDashoffset), { timeout: 1_500 }).not.toBe(sourceOffset);

  await dock.getByLabel("平移画布").click();
  await expect(page.locator(".kc-workspace")).toHaveClass(/is-space-pan/);
  await expect(page.locator(".react-flow__pane")).toHaveCSS("cursor", "grab");
  await expect(inbound.first()).toHaveCSS("animation-play-state", "paused");
  await dock.getByLabel("平移画布").click();
  // 关掉平移后 XYFlow 把面板交还给框选模式（.react-flow__pane.selection），
  // 原生光标因此是 pointer 而不是 default；关键是它不再是 grab。
  await expect(page.locator(".react-flow__pane")).toHaveCSS("cursor", "pointer");
  await expect(inbound.first()).toHaveCSS("animation-play-state", "running");
  await page.screenshot({ path: testInfo.outputPath("appearance-toolbar-stardust.png") });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(inbound.first()).toHaveCSS("animation-name", "kc-edge-star-gather");
  await expect(inbound.first()).toHaveCSS("animation-duration", "7.2s");
  await expect(pulse).toBeAttached();
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-node-style", "airy");
  await expect(page.locator("html")).toHaveAttribute("data-chrome-style", "airy");
  await expect(page.locator("html")).toHaveAttribute("data-edge-path-style", "gravity");
  await expect(page.locator("html")).toHaveAttribute("data-edge-flow-style", "stardust");
  await expect(page.locator("html")).not.toHaveAttribute("data-accent");
  await expect(page.locator("html")).not.toHaveAttribute("data-cursor-style");
  await page.getByLabel("打开 UI 设置").click();
  await expect(page.getByRole("group", { name: "新建媒体节点默认画幅" }).getByRole("button", { name: "3:4", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("tab", { name: "交互" }).click();
  await expect(page.getByRole("group", { name: "连线形态" }).getByRole("button", { name: "柔弧" })).toHaveAttribute("aria-pressed", "true");
});

test("retired cosmos and lingjing archives normalize onto the airy default", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("kachang-canvas:ui-preferences:v1", JSON.stringify({
      canvasVisualStyle: "cosmos",
      chromeVisualStyle: "lingjing",
    }));
  });
  await page.reload();

  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-node-style", "airy");
  await expect(root).toHaveAttribute("data-chrome-style", "airy");
  await expect(root).toHaveAttribute("data-canvas-style", "airy");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 4_000 });

  // The retired tiers must not break the UI: the canvas renders with airy
  // material and the settings panel still opens with 疏朗 selected.
  await page.getByLabel("打开 UI 设置").click();
  const settings = page.getByRole("dialog", { name: "UI 设置" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("group", { name: "节点样式" }).getByRole("button", { name: "疏朗", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(settings.getByRole("group", { name: "界面与功能栏样式" }).getByRole("button", { name: "疏朗", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".kc-node-surface").first()).toHaveCSS("border-radius", "3px");
});

test("quiet generation effect is selectable and persists across reloads", async ({ page }) => {
  await page.getByLabel("打开 UI 设置").click();
  const settings = page.getByRole("dialog", { name: "UI 设置" });
  await settings.getByRole("group", { name: "生成动效" }).getByRole("button", { name: "光环生成动效" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-generation-effect", "quiet");
  await expect(settings.getByRole("group", { name: "生成动效" }).getByRole("button", { name: "光环生成动效" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-generation-effect", "quiet");
  await page.getByLabel("打开 UI 设置").click();
  await expect(page.getByRole("group", { name: "生成动效" }).getByRole("button", { name: "光环生成动效" })).toHaveAttribute("aria-pressed", "true");
});

test("光环 ring and preview rotate at the aligned ~2.4s cadence with stable geometry", async ({ page }) => {
  await page.addInitScript(() => {
    const now = Date.now();
    const generation = {
      modelId: null,
      parameters: {},
      maxOutputTokens: null,
      referenceMode: "auto",
      referenceNodeIds: [],
      jobId: "quiet-ring-job",
      jobVersion: 1,
      jobCreatedAt: new Date(now).toISOString(),
      jobStatus: "running",
      error: null,
    };
    const project = {
      schemaVersion: 1,
      id: "appearance-quiet-project",
      name: "Appearance quiet",
      nodes: [{
        id: "running-video",
        type: "kachang",
        position: { x: 620, y: 220 },
        width: 340,
        height: 192,
        selected: false,
        data: {
          kind: "video",
          body: "Running video",
          accent: "cobalt",
          status: "running",
          progress: 42,
          media: null,
          directorCapture: null,
          config: null,
          generation,
          createdAt: now,
          updatedAt: now,
        },
      }],
      edges: [],
      groups: [],
      viewport: { x: 80, y: 100, zoom: 0.9 },
      createdAt: now,
      updatedAt: now,
    };
    localStorage.clear();
    localStorage.setItem(`kachang-canvas:project-data:v1:${encodeURIComponent(project.id)}`, JSON.stringify(project));
    localStorage.setItem("kachang-canvas:projects:v1", JSON.stringify({
      version: 1,
      projects: [{ id: project.id, name: project.name, createdAt: now, updatedAt: now, nodeCount: 1 }],
    }));
    localStorage.setItem("kachang-canvas:active-project:v1", project.id);
    localStorage.setItem("kachang-canvas:ui-preferences:v1", JSON.stringify({ generationEffectStyle: "quiet" }));
  });

  // Apply the seeded project/preferences fixture on a fresh navigation.
  await page.goto("/canvas");
  await expect(page.locator("html")).toHaveAttribute("data-generation-effect", "quiet");

  await page.getByLabel("打开 UI 设置").click();
  const settings = page.getByRole("dialog", { name: "UI 设置" });
  const quietChoice = settings.locator(".kc-generation-effect-choice.is-quiet");
  await expect(quietChoice).toBeVisible();

  // The appearance preview ring rotates at ~2.4s, matching the real node ring.
  const previewDuration = await quietChoice.locator(".is-primary").evaluate((element) =>
    getComputedStyle(element, "::after").animationDuration);
  expect(previewDuration).toBe("2.4s");
  await expect.poll(() => quietChoice.locator(".is-primary").evaluate((element) =>
    getComputedStyle(element, "::after").animationName)).toBe("kc-preview-quiet");
  const previewRotationA = await quietChoice.locator(".is-primary").evaluate((element) =>
    getComputedStyle(element, "::after").transform);
  await expect.poll(() => quietChoice.locator(".is-primary").evaluate((element) =>
    getComputedStyle(element, "::after").transform)).not.toBe(previewRotationA);

  // The real quiet ring rotates at the same ~2.4s cadence with a stable 36px
  // geometry, so two frames visibly advance the rotation without layout drift.
  const runningNode = page.locator('.react-flow__node-kachang[data-id="running-video"]');
  const ring = runningNode.locator(".kc-quiet-ring");
  await expect(ring).toBeVisible();
  const ringDuration = await ring.evaluate((element) => getComputedStyle(element, "::before").animationDuration);
  expect(ringDuration).toBe("2.4s");
  await expect.poll(() => ring.evaluate((element) => getComputedStyle(element, "::before").animationName))
    .toBe("kc-quiet-ring-rotate");
  const rotationA = await ring.evaluate((element) => getComputedStyle(element, "::before").transform);
  await expect.poll(() => ring.evaluate((element) => getComputedStyle(element, "::before").transform)).not.toBe(rotationA);
  const boxA = await ring.boundingBox();
  await page.waitForTimeout(180);
  const boxB = await ring.boundingBox();
  expect(boxA).not.toBeNull();
  expect(boxB).not.toBeNull();
  expect(Math.round(boxB!.width)).toBe(Math.round(boxA!.width));
  expect(Math.round(boxB!.height)).toBe(Math.round(boxA!.height));

  // Reduced motion keeps the ring and preview present and animating (slower),
  // never hiding the truthful state.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => ring.evaluate((element) => getComputedStyle(element, "::before").animationName))
    .toBe("kc-quiet-ring-rotate");
  await expect.poll(() => quietChoice.locator(".is-primary").evaluate((element) =>
    getComputedStyle(element, "::after").animationName)).toBe("kc-preview-quiet");
  await expect(runningNode.locator(".kc-node-loading-label")).toContainText("正在生成视频");
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("UI settings remain usable on a narrow viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("打开 UI 设置").click();
  const settings = page.getByRole("dialog", { name: "UI 设置" });
  await expect(settings).toBeVisible();

  const bounds = await settings.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await settings.getByRole("tab", { name: "交互" }).click();
  await settings.getByRole("group", { name: "连线形态" }).scrollIntoViewIfNeeded();
  await settings.getByRole("group", { name: "连线形态" }).getByRole("button", { name: "柔弧" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-edge-path-style", "gravity");
  await expect(settings.getByRole("group", { name: "鼠标样式" })).toHaveCount(0);
  await settings.getByRole("group", { name: "节点加号样式" }).scrollIntoViewIfNeeded();
  await settings.getByRole("group", { name: "节点加号样式" }).getByRole("button", { name: "简洁" }).click();
  await expect(page.locator('[data-node-port-style="compact"]')).not.toHaveCount(0);
  await settings.getByRole("tab", { name: "视觉" }).click();
  await settings.getByRole("group", { name: "节点样式" }).scrollIntoViewIfNeeded();
  await settings.getByRole("group", { name: "节点样式" }).getByRole("button", { name: "巨幕", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-node-style", "imax");
  await expect(settings.getByRole("group", { name: "主题配色" })).toHaveCount(0);
  await expect(settings.getByRole("group", { name: "配色方案" }).getByRole("button")).toHaveText(["石墨", "墨黑"]);
  await expect(page.locator("html")).not.toHaveAttribute("data-accent");
  const panelOverflow = await settings.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(panelOverflow.scrollWidth).toBe(panelOverflow.clientWidth);
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await page.waitForTimeout(220);
  const narrowImaxSurface = page.locator(".kc-node-surface").first();
  await expect(narrowImaxSurface).toHaveCSS("border-radius", "0px");
  await expect.poll(() => narrowImaxSurface.evaluate((element) => getComputedStyle(element).clipPath)).toContain("kc-imax-screen-clip");
  const documentOverflow = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(documentOverflow.scrollWidth).toBeLessThanOrEqual(documentOverflow.width);
  await page.screenshot({ path: testInfo.outputPath("appearance-toolbar-imax-narrow.png"), fullPage: true });
});

test("UI settings panel stays above the bottom dock on a desktop viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 2048, height: 1024 });
  await page.locator('button[aria-label*="UI"]').first().click();
  const settings = page.locator(".kc-ui-settings");
  await expect(settings).toBeVisible();

  const bounds = await settings.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeLessThan(600);
  expect(bounds!.height).toBeGreaterThan(400);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(950);

  const content = settings.locator('.kc-ui-settings-panel:not([hidden])');
  const contentBounds = await content.boundingBox();
  expect(contentBounds).not.toBeNull();
  expect(contentBounds!.height).toBeGreaterThan(200);
  expect(contentBounds!.y).toBeGreaterThan(bounds!.y + 70);
  await page.screenshot({ path: testInfo.outputPath("ui-settings-desktop-2048x1024.png") });
});

test("default aspect ratio controls new media-node geometry and keeps toolbar creation centered", async ({ page }) => {
  const settingsTrigger = page.getByLabel("打开 UI 设置");
  await settingsTrigger.click();
  const settings = page.getByRole("dialog", { name: "UI 设置" });
  const defaultAspect = settings.getByRole("group", { name: "新建媒体节点默认画幅" });
  await defaultAspect.getByRole("button", { name: "9:16", exact: true }).click();
  await page.keyboard.press("Escape");

  await page.getByRole("navigation", { name: "创建工具" }).locator(".kc-create-rail-plus-wrapper").hover();
  await page.getByRole("navigation", { name: "创建工具" }).getByRole("menuitem", { name: "添加图片节点" }).click();
  const createdImage = page.locator('.react-flow__node-kachang.selected:has(.kc-node-wrap[data-node-kind="image"])');
  await expect(createdImage).toHaveCount(1);
  await expect.poll(() => createdImage.evaluate((element) => ({
    width: getComputedStyle(element).width,
    height: getComputedStyle(element).height,
  }))).toEqual({ width: "191px", height: "340px" });
  await expect.poll(async () => {
    const [nodeBounds, canvasBounds] = await Promise.all([
      createdImage.boundingBox(),
      page.locator(".kc-flow-shell").boundingBox(),
    ]);
    if (!nodeBounds || !canvasBounds) return Number.POSITIVE_INFINITY;
    const nodeCenterX = nodeBounds.x + nodeBounds.width / 2;
    const nodeCenterY = nodeBounds.y + nodeBounds.height / 2;
    const canvasCenterX = canvasBounds.x + canvasBounds.width / 2;
    const canvasCenterY = canvasBounds.y + canvasBounds.height / 2;
    return Math.max(Math.abs(nodeCenterX - canvasCenterX), Math.abs(nodeCenterY - canvasCenterY));
  }).toBeLessThan(2);

  await settingsTrigger.click();
  await defaultAspect.getByRole("button", { name: "4:3", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("navigation", { name: "创建工具" }).locator(".kc-create-rail-plus-wrapper").hover();
  await page.getByRole("navigation", { name: "创建工具" }).getByRole("menuitem", { name: "添加视频节点" }).click();
  const createdVideo = page.locator('.react-flow__node-kachang.selected:has(.kc-node-wrap[data-node-kind="video"])');
  await expect.poll(() => createdVideo.evaluate((element) => ({
    width: getComputedStyle(element).width,
    height: getComputedStyle(element).height,
  }))).toEqual({ width: "340px", height: "255px" });
});

test("node and chrome presets change independently", async ({ page }, testInfo) => {
  await page.getByLabel("打开 UI 设置").click();
  const settings = page.getByRole("dialog", { name: "UI 设置" });
  const nodeStyles = settings.getByRole("group", { name: "节点样式" });
  const chromeStyles = settings.getByRole("group", { name: "界面与功能栏样式" });
  const surface = page.locator(".kc-node-surface").first();
  const emptyMedia = page.locator(".kc-media-empty").first();
  const topbar = page.locator(".kc-topbar-actions");
  await expect(chromeStyles.getByRole("button", { name: "巨幕", exact: true })).toHaveCount(0);

  const chromeBefore = await topbar.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundImage, border: style.borderTopColor, radius: style.borderRadius };
  });
  await nodeStyles.getByRole("button", { name: "无界", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-node-style", "studio");
  await expect(page.locator("html")).toHaveAttribute("data-chrome-style", "airy");
  await expect(surface).toHaveCSS("border-radius", "7px");
  await expect.poll(() => topbar.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundImage, border: style.borderTopColor, radius: style.borderRadius };
  })).toEqual(chromeBefore);

  await nodeStyles.getByRole("button", { name: "疏朗", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-node-style", "airy");
  await expect(page.locator("html")).toHaveAttribute("data-chrome-style", "airy");
  await expect(surface).toHaveCSS("border-radius", "3px");
  await expect.poll(() => topbar.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundImage, border: style.borderTopColor, radius: style.borderRadius };
  })).toEqual(chromeBefore);

  await page.waitForTimeout(240);
  const nodeBefore = await surface.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundImage, border: style.borderTopColor, radius: style.borderRadius };
  });
  await chromeStyles.getByRole("button", { name: "经典", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-node-style", "airy");
  await expect(page.locator("html")).toHaveAttribute("data-chrome-style", "classic");
  await expect.poll(() => surface.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundImage, border: style.borderTopColor, radius: style.borderRadius };
  })).toEqual(nodeBefore);

  await nodeStyles.getByRole("button", { name: "巨幕", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-node-style", "imax");
  await expect(page.locator("html")).toHaveAttribute("data-chrome-style", "classic");
  await expect(surface).toHaveCSS("border-radius", "0px");
  await expect(page.locator("#kc-imax-screen-clip")).toHaveCount(1);
  await expect(page.locator("#kc-imax-screen-inner-clip")).toHaveCount(1);
  await expect(page.locator("#kc-imax-screen-clip path")).toHaveAttribute("d", "M0,0 Q.5,.18 1,0 L1,1 Q.5,.82 0,1 Z");
  const imaxMaterial = await surface.evaluate((element) => ({
    animationName: getComputedStyle(element).animationName,
    filter: getComputedStyle(element).filter,
    clipPath: getComputedStyle(element).clipPath,
    outerClipPath: getComputedStyle(element, "::before").clipPath,
    innerClipPath: getComputedStyle(element, "::after").clipPath,
    innerInset: getComputedStyle(element, "::after").inset,
  }));
  expect(imaxMaterial.animationName).toBe("none");
  expect(imaxMaterial.filter).toBe("none");
  expect(imaxMaterial.clipPath).toContain("kc-imax-screen-clip");
  expect(imaxMaterial.outerClipPath).toContain("kc-imax-screen-clip");
  expect(imaxMaterial.innerClipPath).toContain("kc-imax-screen-inner-clip");
  expect(imaxMaterial.innerInset).toBe("4px");
  const emptyMediaMaterial = await emptyMedia.evaluate((element) => ({
    radius: getComputedStyle(element).borderRadius,
    shadow: getComputedStyle(element).boxShadow,
  }));
  expect(emptyMediaMaterial).toEqual({ radius: "0px", shadow: "none" });
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await page.waitForTimeout(220);
  await page.screenshot({ path: testInfo.outputPath("appearance-toolbar-imax.png"), fullPage: true });
});

test("node, chrome, and background presets persist independently", async ({ page }) => {
  const root = page.locator("html");
  const shell = page.locator(".kc-flow-shell");
  const surface = page.locator(".kc-node-surface").first();
  const topbar = page.locator(".kc-topbar-actions");
  const settingsTrigger = page.locator('[aria-controls="kc-appearance-toolbar"]');

  await settingsTrigger.click();
  const settings = page.locator("#kc-appearance-toolbar");
  // 按 aria-label 取分组：面板里再插入新分组不应该让这条测试整体错位。
  const group = (name: string) => settings.getByRole("group", { name });
  const nodeStyles = group("节点样式").getByRole("button");
  const chromeStyles = group("界面与功能栏样式").getByRole("button");
  const backgroundStyles = group("背景样式").getByRole("button");

  const chromeBefore = await topbar.evaluate(readAppearance);
  await nodeStyles.nth(1).click();
  await expect(root).toHaveAttribute("data-node-style", "studio");
  await expect(root).toHaveAttribute("data-chrome-style", "airy");
  await expect(surface).toHaveCSS("border-radius", "7px");
  await expect.poll(() => topbar.evaluate(readAppearance)).toEqual(chromeBefore);

  await page.waitForTimeout(240);
  const nodeBefore = await surface.evaluate(readAppearance);
  await chromeStyles.nth(2).click();
  await backgroundStyles.nth(3).click();
  await expect(root).toHaveAttribute("data-node-style", "studio");
  await expect(root).toHaveAttribute("data-chrome-style", "classic");
  await expect(shell).toHaveAttribute("data-canvas-background", "water");
  await expect.poll(() => surface.evaluate(readAppearance)).toEqual(nodeBefore);

  await page.keyboard.press("Escape");
  const textNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="text"])');
  await textNode.locator(".kc-node-drag-strip").click();
  const nodeToolbar = page.locator(".kc-node-action-toolbar");
  const fixedPrompt = page.locator(".kc-node-prompt-composer");
  await expect(nodeToolbar).toBeVisible();
  await expect(fixedPrompt).toBeVisible();
  const toolbarClassic = await nodeToolbar.evaluate(readAppearance);
  const promptClassic = await fixedPrompt.evaluate(readAppearance);

  await settingsTrigger.click();
  await nodeStyles.nth(0).click();
  await expect(root).toHaveAttribute("data-node-style", "airy");
  await expect(root).toHaveAttribute("data-chrome-style", "classic");
  await expect(shell).toHaveAttribute("data-canvas-background", "water");
  await expect(surface).toHaveCSS("border-radius", "3px");
  await textNode.hover();
  await expect(nodeToolbar).toBeVisible();
  await expect.poll(() => nodeToolbar.evaluate(readAppearance)).toEqual(toolbarClassic);
  await expect.poll(() => fixedPrompt.evaluate(readAppearance)).toEqual(promptClassic);

  await nodeStyles.nth(2).click();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 4_000 });
  await expect(root).toHaveAttribute("data-node-style", "classic");
  await expect(root).toHaveAttribute("data-chrome-style", "classic");
  await expect(shell).toHaveAttribute("data-canvas-background", "water");
  await expect(page.getByTestId("canvas-water-surface")).toBeVisible();

  await settingsTrigger.click();
  await expect(nodeStyles.nth(2)).toHaveAttribute("aria-pressed", "true");
  await expect(chromeStyles.nth(2)).toHaveAttribute("aria-pressed", "true");
  await expect(backgroundStyles.nth(3)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");

  await textNode.locator(".kc-node-drag-strip").click();
  await expect.poll(() => nodeToolbar.evaluate(readAppearance)).toEqual(toolbarClassic);
  await expect.poll(() => fixedPrompt.evaluate(readAppearance)).toEqual(promptClassic);
});

function readAppearance(element: Element) {
  const style = getComputedStyle(element);
  return {
    backgroundColor: style.backgroundColor,
    backgroundImage: style.backgroundImage,
    borderColor: style.borderTopColor,
    borderRadius: style.borderRadius,
    boxShadow: style.boxShadow,
  };
}

test("UI settings move focus in on open and restore it on Escape", async ({ page }) => {
  const trigger = page.getByLabel("打开 UI 设置");
  await trigger.focus();
  await page.keyboard.press("Enter");

  const settings = page.getByRole("dialog", { name: "UI 设置" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("group", { name: "节点样式" }).getByRole("button", { name: "疏朗", exact: true })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(page.getByLabel("打开 UI 设置")).toBeFocused();
});
