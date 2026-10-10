import { expect, test, type Page } from "@playwright/test";

const NODE_COUNT = 120;

function frameMetrics(intervals: number[]) {
  const sorted = [...intervals].sort((left, right) => left - right);
  const percentile = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!;
  return {
    frames: intervals.length,
    p50: percentile(0.5),
    p90: percentile(0.9),
    p95: percentile(0.95),
  };
}

function reportFrameMetrics(label: string, intervals: number[]) {
  const metrics = frameMetrics(intervals);
  console.log(`[dense-canvas] ${label} ${JSON.stringify(metrics)}`);
  return metrics;
}

// Trace 的逐帧截图会直接污染这里测量的 requestAnimationFrame 间隔。
test.use({ trace: "off" });

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.route("**/api/v1/model-catalog*", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "dense-canvas-empty-catalog",
        capabilityVersion: "dense-canvas-empty-capability",
        pricingVersion: "dense-canvas-empty-pricing",
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        quoteAvailable: false,
        models: [],
      },
    },
  }));
  await page.addInitScript((nodeCount) => {
    localStorage.clear();
    const now = Date.now();
    const projectId = "project-dense";
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({
      id: `dense-${index}`,
      type: "kachang",
      position: { x: (index % 12) * 260, y: Math.floor(index / 12) * 188 },
      width: 220,
      height: 150,
      selected: false,
      data: {
        kind: index === 0 ? "image" : "text",
        body: index === 0 ? "主视觉提示词" : `镜头 ${index + 1}`,
        accent: "jade",
        status: "idle",
        progress: null,
        media: null,
        directorCapture: null,
        config: null,
        generation: {
          modelId: null,
          parameters: {},
          maxOutputTokens: null,
          referenceNodeIds: [],
          jobId: null,
          jobVersion: null,
          jobCreatedAt: null,
          jobStatus: null,
          error: null,
        },
        createdAt: now,
        updatedAt: now,
      },
    }));
    const edges = Array.from({ length: nodeCount - 1 }, (_, index) => ({
      id: `dense-edge-${index}`,
      source: `dense-${index}`,
      target: `dense-${index + 1}`,
      selected: false,
    }));
    const project = {
      schemaVersion: 1,
      id: projectId,
      name: "密集画布",
      nodes,
      edges,
      groups: [],
      viewport: { x: 92, y: 84, zoom: 0.46 },
      createdAt: now,
      updatedAt: now,
    };
    localStorage.setItem(`kachang-canvas:project-data:v1:${projectId}`, JSON.stringify(project));
    localStorage.setItem("kachang-canvas:projects:v1", JSON.stringify({
      version: 1,
      projects: [{ id: projectId, name: project.name, createdAt: now, updatedAt: now, nodeCount }],
    }));
    localStorage.setItem("kachang-canvas:active-project:v1", projectId);
    localStorage.setItem("kachang-canvas:ui-preferences:v1", JSON.stringify({
      canvasVisualStyle: "imax",
      edgePathStyle: "gravity",
      edgeFlowStyle: "stardust",
    }));
  }, NODE_COUNT);
});

async function openDenseCanvas(page: Page) {
  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 15_000 });
  // 加载条消失不等于工作区已就绪：直接 page.evaluate 会读到空画布，
  // 因此等到第一个真实节点出现再返回。
  await expect(page.locator(".react-flow__node-kachang").first()).toBeVisible({ timeout: 15_000 });
}

test("dense canvas keeps pan feedback responsive and selected-edge energy bounded", async ({ page }, testInfo) => {
  const errors: string[] = [];
  const handleWarnings: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "warning" && message.text().includes("Couldn't create edge")) {
      handleWarnings.push(message.text());
    }
  });
  await openDenseCanvas(page);
  await expect(page.locator("html")).toHaveAttribute("data-node-style", "imax");
  await expect(page.locator("html")).toHaveAttribute("data-edge-path-style", "gravity");
  await expect(page.locator("html")).toHaveAttribute("data-edge-flow-style", "stardust");
  await page.getByLabel("打开 UI 设置").click();
  const settings = page.getByRole("dialog", { name: "UI 设置" });
  await settings.getByRole("group", { name: "背景样式" }).getByRole("button", { name: "水面", exact: true }).click();
  await page.getByLabel("收起 UI 设置").click();
  const waterMaterial = page.getByTestId("canvas-water-surface").locator(".kc-canvas-water-material");
  await expect(waterMaterial).toBeVisible();
  const waterTransformBeforePan = await waterMaterial.evaluate((element) => getComputedStyle(element).transform);
  const visibleNodes = page.locator(".react-flow__node-kachang");
  await expect(visibleNodes.first()).toBeVisible();
  expect(await visibleNodes.count()).toBeGreaterThan(40);
  const ambientEnergy = page.locator(".kc-edge-effect--stardust.is-ambient");
  await expect.poll(() => ambientEnergy.count()).toBeGreaterThan(0);
  expect(await ambientEnergy.count()).toBeLessThanOrEqual(12);
  await expect(page.locator(".kc-edge-gravity-depth")).toHaveCount(0);
  expect(await page.locator(".kc-edge-renderer.is-soft-curve .react-flow__edge-path").count()).toBeGreaterThan(40);
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await page.waitForTimeout(420);

  const pane = page.locator(".react-flow__pane");
  // dense-17 在本测试的平移前后都留在视口内，避免 React Flow 卸载节点干扰降级样式断言。
  const textNode = page.locator('.react-flow__node-kachang[data-id="dense-17"]');
  const textPreview = textNode.locator(".kc-node-text-preview");
  await expect(textNode).toBeVisible();
  await expect(textPreview).toHaveCSS("visibility", "visible");
  await textNode.locator(".kc-node-drag-strip").click();
  const activeEnergy = page.locator(".kc-edge-effect--stardust.is-active");
  await expect.poll(() => activeEnergy.count()).toBeGreaterThan(0);
  expect(await activeEnergy.count()).toBeLessThanOrEqual(2);
  expect(await page.locator(".kc-edge-effect--stardust").count()).toBeLessThanOrEqual(14);
  await expect(activeEnergy.first().locator(".kc-edge-star-inbound")).toHaveCount(2);
  await expect(activeEnergy.first().locator(".kc-edge-star-inbound").first()).toHaveCSS("animation-play-state", "running");
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();
  const frameSample = page.evaluate(() => new Promise<number[]>((resolve) => {
    const intervals: number[] = [];
    let previous = performance.now();
    const deadline = previous + 1_100;
    const sample = (now: number) => {
      intervals.push(now - previous);
      previous = now;
      if (now < deadline) requestAnimationFrame(sample);
      else resolve(intervals.slice(1));
    };
    requestAnimationFrame(sample);
  }));
  await page.keyboard.down("Space");
  await page.mouse.move(paneBox!.x + paneBox!.width * 0.72, paneBox!.y + paneBox!.height * 0.68);
  await page.mouse.down();
  await page.mouse.move(paneBox!.x + paneBox!.width * 0.48, paneBox!.y + paneBox!.height * 0.5, { steps: 24 });
  // Space 平移和 React Flow 视口移动会先后设置状态，任一状态出现时低缩放降级都必须已经生效。
  await expect.poll(() => page.locator(".kc-workspace").evaluate((element) => (
    element.classList.contains("is-space-pan") || element.classList.contains("is-viewport-moving")
  ))).toBe(true);
  const imaxSurface = textNode.locator(".kc-node-surface");
  await expect.poll(() => imaxSurface.evaluate((element) => ({
    before: getComputedStyle(element, "::before").display,
    after: getComputedStyle(element, "::after").display,
    shadow: getComputedStyle(element).boxShadow,
  }))).toEqual({ before: "none", after: "none", shadow: "none" });
  await expect.poll(() => imaxSurface.evaluate((element) => getComputedStyle(element).clipPath)).toContain("kc-imax-screen-clip");
  await expect(activeEnergy.first().locator(".kc-edge-star-inbound").first()).toHaveCSS("animation-play-state", "paused");
  await expect(textPreview).toHaveCSS("visibility", "visible");
  await expect(page.locator(".react-flow__edges")).toHaveCSS("visibility", "visible");
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect.poll(() => waterMaterial.evaluate((element) => getComputedStyle(element).transform)).not.toBe(waterTransformBeforePan);
  await expect(textPreview).toHaveCSS("visibility", "visible");
  const intervals = await frameSample;
  const metrics = reportFrameMetrics("pan", intervals);
  await testInfo.attach("dense-pan-frame-sample.json", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
  const panMetrics = JSON.stringify(metrics);
  expect(intervals.length, panMetrics).toBeGreaterThan(15);
  expect(metrics.p50, panMetrics).toBeLessThan(34);
  expect(metrics.p90, panMetrics).toBeLessThan(34);
  expect(metrics.p95, panMetrics).toBeLessThan(51);
  // 平移测量结束后不应残留拖拽态（自绘光标的 is-pan-grabbing 已随组件删除）。
  await expect(page.locator(".react-flow__pane")).not.toHaveClass(/dragging/);
  await page.screenshot({ path: testInfo.outputPath("dense-overview.png") });

  await expect(activeEnergy.first().locator(".kc-edge-star-inbound").first()).toHaveCSS("animation-play-state", "running");

  await page.keyboard.press("Control+A");
  await expect(page.locator(".kc-selection-toolbar-count")).toHaveText(String(NODE_COUNT));
  await expect(page.locator(".react-flow__node-kachang:not(.selected)")).toHaveCount(0);
  await expect(activeEnergy).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(handleWarnings).toEqual([]);
});

test("dense canvas clears the low-cost interaction mode after an interrupted multi-selection drag", async ({ page }) => {
  await openDenseCanvas(page);
  await page.keyboard.press("Control+A");
  const selectedNode = page.locator('.react-flow__node-kachang[data-id="dense-17"]');
  await expect(selectedNode).toHaveClass(/selected/);
  const dragStrip = selectedNode.locator(".kc-node-drag-strip");
  const stripBox = await dragStrip.boundingBox();
  expect(stripBox).not.toBeNull();

  await page.mouse.move(stripBox!.x + stripBox!.width / 2, stripBox!.y + stripBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(stripBox!.x + 52, stripBox!.y + 34, { steps: 5 });
  await expect(page.locator(".kc-workspace")).toHaveClass(/is-node-dragging/);

  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true })));
  await expect(page.locator(".kc-workspace")).not.toHaveClass(/is-node-dragging/);
  await page.mouse.up();
});

test("dense canvas keeps the fixed prompt panel responsive while dragging its selected node", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openDenseCanvas(page);

  const imageNode = page.locator('.react-flow__node-kachang:has([data-node-kind="image"])');
  await expect(imageNode).toBeVisible();
  await imageNode.locator(".kc-node-drag-strip").click();
  const composer = page.locator("[data-node-prompt-composer]");
  await expect(composer).toBeVisible();
  // 让选中后的目录读取与面板布局先稳定下来，采样只覆盖实际拖动路径。
  await page.waitForTimeout(320);

  const nodeBox = await imageNode.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(nodeBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  // 用户要求输入框始终固定在节点下方，拖动前先锁住这个几何关系。
  expect(composerBox!.y).toBeGreaterThanOrEqual(nodeBox!.y + nodeBox!.height - 2);

  const frameSample = page.evaluate(() => new Promise<number[]>((resolve) => {
    const intervals: number[] = [];
    let previous = performance.now();
    const deadline = previous + 1_100;
    const sample = (now: number) => {
      intervals.push(now - previous);
      previous = now;
      if (now < deadline) requestAnimationFrame(sample);
      else resolve(intervals.slice(1));
    };
    requestAnimationFrame(sample);
  }));
  const dragStrip = imageNode.locator(".kc-node-drag-strip");
  const stripBox = await dragStrip.boundingBox();
  expect(stripBox).not.toBeNull();
  await imageNode.evaluate((element) => {
    const samples: number[] = [];
    let lastPointerMove: number | null = null;
    const onPointerMove = () => {
      lastPointerMove = performance.now();
    };
    const observer = new MutationObserver(() => {
      if (lastPointerMove === null) return;
      samples.push(performance.now() - lastPointerMove);
      lastPointerMove = null;
    });
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    observer.observe(element, { attributes: true, attributeFilter: ["style"] });
    (window as typeof window & { __kcReadDragLatency?: () => number[] }).__kcReadDragLatency = () => {
      observer.disconnect();
      window.removeEventListener("pointermove", onPointerMove, { capture: true });
      return samples;
    };
  });
  await page.mouse.move(stripBox!.x + stripBox!.width / 2, stripBox!.y + stripBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(stripBox!.x + 96, stripBox!.y + 64, { steps: 18 });
  await expect(page.locator(".kc-workspace")).toHaveClass(/is-node-dragging/);
  await expect(composer).toBeHidden();
  await page.mouse.up();

  const intervals = await frameSample;
  const metrics = reportFrameMetrics("selected-node-drag", intervals);
  const dragLatencies = await page.evaluate(() => (
    (window as typeof window & { __kcReadDragLatency?: () => number[] }).__kcReadDragLatency?.() ?? []
  ));
  const latencyMetrics = reportFrameMetrics("node-input-to-transform", dragLatencies);
  await testInfo.attach("selected-node-drag-frame-sample.json", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("node-input-to-transform-sample.json", {
    body: JSON.stringify({ ...latencyMetrics, samples: dragLatencies }, null, 2),
    contentType: "application/json",
  });
  const dragMetrics = JSON.stringify(metrics);
  expect(intervals.length, dragMetrics).toBeGreaterThan(15);
  // Headless Chromium is normally 60 Hz, so frame intervals are expected at
  // 16.7 ms multiples. Direct transform latency enforces the 120 Hz budget.
  expect(metrics.p50, dragMetrics).toBeLessThan(34);
  expect(metrics.p90, dragMetrics).toBeLessThan(34);
  expect(metrics.p95, dragMetrics).toBeLessThan(51);
  expect(dragLatencies.length, JSON.stringify(latencyMetrics)).toBeGreaterThan(3);
  expect(latencyMetrics.p90, JSON.stringify(latencyMetrics)).toBeLessThan(8);
  await expect(composer).toBeVisible();
  expect(errors).toEqual([]);
});

test("pointer feedback is positioned within the same event dispatch", async ({ page }) => {
  await openDenseCanvas(page);

  const transform = await page.evaluate(() => {
    const pulse = document.querySelector<HTMLElement>("[data-testid='pointer-pulse']");
    if (!pulse) throw new Error("Pointer feedback element is missing");
    const target = document.querySelector<HTMLElement>(".react-flow__node");
    if (!target) throw new Error("No interactive target to hover");
    target.dispatchEvent(new PointerEvent("pointerover", {
      bubbles: true,
      clientX: 211,
      clientY: 137,
      pointerType: "mouse",
    }));
    return pulse.style.transform;
  });

  // 反馈环在事件回调里就地定位，不留到下一帧；但它只在悬停切换时更新，
  // 不再逐帧跟随，所以原生光标永远领先于它，观感上不存在延迟。
  expect(transform).toBe("translate3d(211px, 137px, 0px)");
});

test("normal zoom interaction keeps node identity while dropping decorative paint", async ({ page }) => {
  await openDenseCanvas(page);

  const styles = await page.evaluate(() => {
    document.documentElement.dataset.nodeStyle = "classic";
    const workspace = document.querySelector<HTMLElement>(".kc-workspace");
    const surface = document.querySelector<HTMLElement>(".kc-node-surface");
    const text = document.querySelector<HTMLElement>(".kc-node-text-preview");
    const edges = document.querySelector<HTMLElement>(".react-flow__edges");
    if (!workspace || !surface || !text || !edges) throw new Error("Dense canvas is incomplete");
    workspace.classList.remove("is-overview-zoom");
    workspace.classList.add("is-viewport-moving");
    const result = {
      shadow: getComputedStyle(surface).boxShadow,
      material: getComputedStyle(surface, "::after").display,
      borderStyle: getComputedStyle(surface).borderStyle,
      textVisibility: getComputedStyle(text).visibility,
      edgeVisibility: getComputedStyle(edges).visibility,
    };
    workspace.classList.remove("is-viewport-moving");
    return result;
  });

  expect(styles).toEqual({
    shadow: "none",
    material: "none",
    borderStyle: "solid",
    textVisibility: "visible",
    edgeVisibility: "visible",
  });
});
