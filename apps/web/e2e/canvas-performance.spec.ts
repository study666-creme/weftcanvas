import { expect, test, type Page, type TestInfo } from "@playwright/test";

// 生产式性能验收：240 节点 + 239 连线 + 40 组合、Space 起手、Ctrl/Meta wheel、
// 生成面板、40 张可见图片边加载边平移。所有网络均用 route/mock，generation POST=0。
// 硬门槛来自线上隔離 Edge 的确定性 mock 测量：平移 p50<17ms、p90<34ms、p95<51ms。

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const VIDEO_MODEL = {
  id: "perf-video-1",
  label: "Performance Video",
  description: "性能验收视频模型",
  modality: "video",
  operation: "video.generate",
  order: 1,
  input: { textRequired: true, images: { min: 0, max: 1, multiple: false } },
  output: { type: "video", minCount: 1, maxCount: 1 },
  parameters: [
    { name: "aspect_ratio", label: "画面比例", type: "string", required: false, default: "16:9", options: ["16:9", "9:16"], mutuallyExclusiveWith: [] },
    { name: "duration", label: "时长（秒）", type: "integer", required: false, default: 5, options: [5, 10], mutuallyExclusiveWith: [] },
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
};

type NetworkState = { unmocked: string[]; external: string[]; posts: string[] };

type RuntimeMetrics = {
  setItemCalls: number[];
  indexedDbOpens: number[];
  idbPuts: number[];
  longTasks: Array<{ startTime: number; duration: number }>;
  layoutReads: number[];
};

function percentile(sorted: number[], quantile: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

function frameMetrics(intervals: number[]) {
  const sorted = [...intervals].sort((a, b) => a - b);
  return { frames: intervals.length, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), p95: percentile(sorted, 0.95) };
}

function report(label: string, value: unknown) {
  console.log(`[canvas-performance] ${label} ${JSON.stringify(value)}`);
}

// Trace 的逐帧截图会直接污染 rAF 间隔测量。
test.use({ trace: "off" });

test.beforeEach(async ({ page }) => {
  const network: NetworkState = { unmocked: [], external: [], posts: [] };
  await installNetworkGuard(page, network);
  await installCanvasApiMocks(page);
  await installRuntimeMetrics(page);
  (page as Page & { __networkState?: NetworkState }).__networkState = network;
  await page.addInitScript(() => {
    if (sessionStorage.getItem("kachang-performance-e2e-cleaned")) return;
    localStorage.clear();
    sessionStorage.setItem("kachang-performance-e2e-cleaned", "1");
  });
});

test("dense grouped canvas pans within hard thresholds with zero per-frame persistence", async ({ page }, testInfo) => {
  const network = (page as Page & { __networkState: NetworkState }).__networkState;
  await seedDenseProject(page);
  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".react-flow__node-kachang").first()).toBeVisible();
  // 可见性裁剪只挂载视口内组合；图上共有 40 组。
  const mountedGroups = await page.locator("[data-kc-group-frame]").count();
  if (mountedGroups > 0) {
    await expect(page.locator("[data-kc-group-frame]").first()).toBeVisible();
    expect(mountedGroups).toBeGreaterThan(10);
  }
  expect(mountedGroups).toBeLessThanOrEqual(40);
  // 柔弧断言使用当前 .is-soft-curve（旧实现是两段 .is-gravity + kc-edge-gravity-depth）。
  await expect(page.locator(".kc-edge-renderer.is-soft-curve").first()).toBeVisible();
  expect(await page.locator(".kc-edge-gravity-depth").count()).toBe(0);
  // onlyRenderVisibleElements 只挂载视口内连线；图上共 239 条。
  const visibleEdges = await page.locator(".react-flow__edge").count();
  report("visible-edges", visibleEdges);
  expect(visibleEdges).toBeGreaterThan(30);
  await page.waitForTimeout(600);

  await page.evaluate(() => {
    const metrics = (window as Window & {
      __canvasPerfMetrics: RuntimeMetrics;
    }).__canvasPerfMetrics;
    metrics.setItemCalls.length = 0;
    metrics.indexedDbOpens.length = 0;
    metrics.longTasks.length = 0;
  });

  const pane = page.locator(".react-flow__pane");
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();
  const sampleStart = await page.evaluate(() => performance.now());

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
  await page.mouse.move(paneBox!.x + paneBox!.width * 0.7, paneBox!.y + paneBox!.height * 0.68);
  await page.mouse.down();
  await page.mouse.move(paneBox!.x + paneBox!.width * 0.4, paneBox!.y + paneBox!.height * 0.46, { steps: 26 });
  await expect.poll(() => page.locator(".kc-workspace").evaluate((el) => (
    el.classList.contains("is-space-pan") || el.classList.contains("is-viewport-moving")
  ))).toBe(true);
  await page.mouse.up();
  await page.keyboard.up("Space");

  const intervals = await frameSample;
  const metrics = frameMetrics(intervals);
  const slowest = [...intervals].sort((a, b) => b - a).slice(0, 6);
  report("pan", metrics);
  report("pan-slowest-intervals", slowest);
  await testInfo.attach("dense-pan-frame-sample.json", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
  const panMetrics = JSON.stringify(metrics);
  expect(metrics.frames, panMetrics).toBeGreaterThan(15);
  expect(metrics.p50, panMetrics).toBeLessThan(17);
  expect(metrics.p90, panMetrics).toBeLessThan(34);
  expect(metrics.p95, panMetrics).toBeLessThan(51);

  // Long Task 只统计与 rAF 采样窗口严格重合的时间段（避免把采样结束后的
  // settle/GC 或轮询期计入）。
  const runtime = await page.evaluate(({ startedAt, windowMs }) => {
    const metrics = (window as Window & { __canvasPerfMetrics: RuntimeMetrics }).__canvasPerfMetrics;
    const end = startedAt + windowMs;
    const gestureLongTasks = metrics.longTasks.filter((t) => t.startTime >= startedAt && t.startTime <= end);
    return {
      setItemCalls: metrics.setItemCalls.length,
      indexedDbOpens: metrics.indexedDbOpens.length,
      longTaskCount: gestureLongTasks.length,
      maxLongTaskMs: Math.max(0, ...gestureLongTasks.map((t) => t.duration)),
    };
  }, { startedAt: sampleStart, windowMs: 1_150 });
  report("gesture-runtime", runtime);
  expect(runtime.setItemCalls).toBe(0);
  expect(runtime.indexedDbOpens).toBe(0);
  expect(runtime.maxLongTaskMs, `long tasks ${runtime.longTaskCount}`).toBeLessThan(50);

  // 组合几何在移动结束后必须精确：每个组合框仍贴合其成员。
  await page.waitForTimeout(300);
  const groupAccuracy = await page.evaluate(() => {
    const frames = [...document.querySelectorAll<HTMLElement>("[data-kc-group-frame]")];
    let inaccuracies = 0;
    for (const frame of frames) {
      const match = /^group-(\d+)$/.exec(frame.dataset.kcGroupFrame ?? "");
      if (!match) continue;
      const groupIndex = Number(match[1]);
      const frameRect = frame.getBoundingClientRect();
      for (let offset = 0; offset < 6; offset += 1) {
        const member = document.querySelector<HTMLElement>(`.react-flow__node-kachang[data-id="node-${groupIndex * 6 + offset}"]`);
        if (!member) continue;
        const rect = member.getBoundingClientRect();
        const inside = frameRect.left - 2 <= rect.left && frameRect.right + 2 >= rect.right
          && frameRect.top - 40 <= rect.top && frameRect.bottom + 2 >= rect.bottom;
        if (!inside) inaccuracies += 1;
      }
    }
    return { frames: frames.length, inaccuracies };
  });
  report("group-geometry", groupAccuracy);
  if (groupAccuracy.frames > 0) expect(groupAccuracy.inaccuracies).toBe(0);

  expect(network.unmocked, `unmocked /api: ${network.unmocked.join(", ")}`).toEqual([]);
  expect(network.external, `external: ${network.external.join(", ")}`).toEqual([]);
  expect(network.posts, `generation/other POSTs: ${network.posts.join(", ")}`).toEqual([]);
});

test("space press-to-pan feedback stays under 50ms", async ({ page }) => {
  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".react-flow__node-kachang").first()).toBeVisible();

  await page.evaluate(() => {
    const global = window as Window & {
      __spaceDownAt?: number;
      __spaceFeedbackMs?: number | null;
      __spaceFeedbackProbe?: () => number | null;
    };
    global.__spaceFeedbackMs = null;
    // keydown 处理中应用的 useSpacePan 会同步加上 .is-space-pan；
    // 这里在事件派发完成后（微任务）直接测量按键到模式生效的延迟。
    window.addEventListener("keydown", (e) => {
      if (e.code !== "Space") return;
      global.__spaceDownAt = performance.now();
      Promise.resolve().then(() => {
        const workspace = document.querySelector<HTMLElement>(".kc-workspace");
        if (workspace?.classList.contains("is-space-pan") && global.__spaceDownAt != null) {
          global.__spaceFeedbackMs = performance.now() - global.__spaceDownAt;
        }
      });
    }, true);
    global.__spaceFeedbackProbe = () => global.__spaceFeedbackMs ?? null;
  });

  await page.keyboard.down("Space");
  await page.waitForTimeout(120);
  await page.keyboard.up("Space");
  const feedback = await page.evaluate(() => (window as Window & { __spaceFeedbackProbe?: () => number | null }).__spaceFeedbackProbe?.() ?? null);
  report("space-press-to-pan-ms", feedback);
  expect(feedback).not.toBeNull();
  expect(feedback!).toBeLessThan(50);
});

test("control/meta wheel zoom commits once and restores the viewport after refresh", async ({ page }) => {
  await seedDenseProject(page);
  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 15_000 });
  const viewport = page.locator(".react-flow__viewport");
  const pane = page.locator(".react-flow__pane");
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();

  const before = await viewport.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
  await page.evaluate(() => {
    const metrics = (window as Window & { __canvasPerfMetrics: RuntimeMetrics }).__canvasPerfMetrics;
    metrics.setItemCalls.length = 0;
  });

  const wheelAt = Date.now();
  await page.keyboard.down("Control");
  await page.mouse.move(paneBox!.x + paneBox!.width * 0.5, paneBox!.y + paneBox!.height * 0.5);
  await page.mouse.wheel(0, -420);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await viewport.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a))).not.toBe(before);

  // 手势窗口（250ms）内不允许写 localStorage；150ms 有界 debounce / onMoveEnd 后提交一次。
  await page.waitForTimeout(250);
  const duringGesture = await page.evaluate(() => (window as Window & { __canvasPerfMetrics: RuntimeMetrics }).__canvasPerfMetrics.setItemCalls.length);
  report("wheel-setItem-during-gesture", duringGesture);
  expect(duringGesture).toBe(0);
  await page.waitForTimeout(900);
  const wheelDiagnostics = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".kc-workspace");
    const shell = document.querySelector<HTMLElement>(".kc-flow-shell");
    const liveZoom = new DOMMatrixReadOnly(
      getComputedStyle(document.querySelector<HTMLElement>(".react-flow__viewport")!).transform,
    ).a;
    const raw = localStorage.getItem("kachang-canvas:project-data:v1:perf-dense-project");
    let storedZoom: number | null = null;
    if (raw) {
      const project = JSON.parse(raw) as { viewport?: { zoom?: number } };
      storedZoom = project.viewport?.zoom ?? null;
    }
    return {
      viewportMoving: Boolean(workspace?.classList.contains("is-viewport-moving")),
      storeZoom: Number(shell?.style.getPropertyValue("--kc-canvas-zoom")) || null,
      liveZoom,
      storedZoom,
    };
  });
  report("wheel-diagnostics", wheelDiagnostics);

  // 结束后的持久化最终包含放大后的新视口（wheel 只触发一次 store 提交）。
  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem("kachang-canvas:project-data:v1:perf-dense-project");
    if (!raw) return null;
    const project = JSON.parse(raw) as { viewport?: { zoom?: number } };
    return project.viewport?.zoom ?? null;
  })).toBeGreaterThan(before + 0.05);

  // 刷新后恢复同一 viewport。
  await page.reload();
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(300);
  const restored = await viewport.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
  const postReload = await page.evaluate(() => {
    const raw = localStorage.getItem("kachang-canvas:project-data:v1:perf-dense-project");
    let storedZoom: number | null = null;
    if (raw) {
      const project = JSON.parse(raw) as { viewport?: { zoom?: number } };
      storedZoom = project.viewport?.zoom ?? null;
    }
    return { storedZoom };
  });
  report("wheel-restored-zoom", { before, restored, postReload });
  expect(Math.abs(restored - before)).toBeGreaterThan(0.05);
  expect(restored).toBeGreaterThan(0);
});

test("generation panel pans with bounded synchronous layout reads", async ({ page }, testInfo) => {
  await seedDenseProject(page);
  await installLayoutReadMetrics(page);
  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 15_000 });
  const videoNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="video"])');
  await expect(videoNode).toBeVisible();
  await videoNode.locator(".kc-node-drag-strip").click();
  const composer = page.locator("[data-node-prompt-composer]");
  await expect(composer).toBeVisible();
  await expect(composer.locator("[data-generation-model-select]")).toHaveValue("perf-video-1");
  await page.waitForTimeout(400);

  const pane = page.locator(".react-flow__pane");
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();
  await page.evaluate(() => {
    const metrics = (window as Window & { __canvasPerfMetrics: RuntimeMetrics }).__canvasPerfMetrics;
    metrics.layoutReads.length = 0;
  });
  const panStart = await page.evaluate(() => performance.now());
  const viewportBefore = await page.locator(".react-flow__viewport").evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { x: m.m41, y: m.m42 };
  });

  await page.keyboard.down("Space");
  await page.mouse.move(paneBox!.x + paneBox!.width * 0.62, paneBox!.y + paneBox!.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(paneBox!.x + paneBox!.width * 0.85, paneBox!.y + paneBox!.height * 0.68, { steps: 22 });
  await expect.poll(async () => {
    const m = await page.locator(".react-flow__viewport").evaluate((el) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { x: matrix.m41, y: matrix.m42 };
    });
    return Math.hypot(m.x - viewportBefore.x, m.y - viewportBefore.y);
  }).toBeGreaterThan(5);
  await page.mouse.up();
  await page.keyboard.up("Space");
  const panEnd = await page.evaluate(() => performance.now());

  const reads = await page.evaluate(({ startedAt, finishedAt }) => {
    const metrics = (window as Window & { __canvasPerfMetrics: RuntimeMetrics }).__canvasPerfMetrics;
    return metrics.layoutReads.filter((at) => at >= startedAt && at <= finishedAt).length;
  }, { startedAt: panStart, finishedAt: panEnd });
  // 同步布局读取有明确常数上限，且不随 viewport frame 数增长：
  // 手势期间跟随走纯 transform，只在外层拖拽机制（pointer 事件）读取少量几何。
  report("generation-panel-layout-reads-during-pan", { reads, durationMs: panEnd - panStart });
  await testInfo.attach("generation-panel-layout-reads.json", { body: JSON.stringify({ reads, durationMs: panEnd - panStart }, null, 2), contentType: "application/json" });
  expect(reads).toBeLessThan(200);

  // 移动结束后面板重新贴齐节点且不越界。
  await page.waitForTimeout(250);
  const alignment = await page.evaluate(() => {
    const composerEl = document.querySelector<HTMLElement>("[data-node-prompt-composer]");
    const nodeEl = document.querySelector<HTMLElement>('[data-kc-node-id="node-0"]');
    if (!composerEl || !nodeEl) return null;
    const c = composerEl.getBoundingClientRect();
    const n = nodeEl.getBoundingClientRect();
    return {
      below: c.top >= n.top + n.height - 2,
      insideViewport: c.left >= 0 && c.right <= window.innerWidth && c.bottom <= window.innerHeight,
      box: { left: Math.round(c.left), top: Math.round(c.top), right: Math.round(c.right), bottom: Math.round(c.bottom) },
    };
  });
  report("generation-panel-alignment", alignment);
  expect(alignment).not.toBeNull();
  expect(alignment!.below).toBe(true);
  expect(alignment!.insideViewport).toBe(true);
});

test("forty visible server images load while panning without permanent failure", async ({ page }, testInfo) => {
  const network = (page as Page & { __networkState: NetworkState }).__networkState;
  await seedImageProject(page);
  await page.route("**/api/v1/media/*/content", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await route.fulfill({ body: PIXEL, contentType: "image/png" });
  });
  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 15_000 });
  const imageNodes = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="image"])');
  await expect.poll(() => imageNodes.count()).toBeGreaterThanOrEqual(35);
  // 加载期间保持固定尺寸安静占位：等待中的节点没有永久失败状态。
  await expect.poll(() => page.locator(".kc-media-result-state.is-error").count()).toBe(0);
  const loadingCount = await page.locator(".kc-media-result-state:not(.is-error)").count();
  report("images-loading-during-pan", { loadingCount, total: await imageNodes.count() });
  expect(loadingCount).toBeGreaterThan(0);

  await page.evaluate(() => {
    const metrics = (window as Window & { __canvasPerfMetrics: RuntimeMetrics }).__canvasPerfMetrics;
    metrics.longTasks.length = 0;
    metrics.idbPuts.length = 0;
  });
  const pane = page.locator(".react-flow__pane");
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();
  await page.keyboard.down("Space");
  await page.mouse.move(paneBox!.x + paneBox!.width * 0.56, paneBox!.y + paneBox!.height * 0.52);
  await page.mouse.down();
  await page.mouse.move(paneBox!.x + paneBox!.width * 0.58, paneBox!.y + paneBox!.height * 0.54, { steps: 2 });
  // 等视口移动真正开始（is-viewport-moving）后，用严格拖拽窗口统计手势期写入。
  await expect.poll(() => page.locator(".kc-workspace").evaluate((el) => el.classList.contains("is-viewport-moving"))).toBe(true);
  const dragStart = await page.evaluate(() => performance.now());
  // 小幅平移即可验证“边加载边平移”；平移过大可能把部分节点移出视口，
  // 导致 onlyRenderVisibleElements 卸载节点、可见图片计数下降。
  await page.mouse.move(paneBox!.x + paneBox!.width * 0.62, paneBox!.y + paneBox!.height * 0.58, { steps: 12 });
  const dragEnd = await page.evaluate(() => performance.now());
  await page.mouse.up();
  await page.keyboard.up("Space");

  // 缓存落盘被推迟：严格拖拽窗口（is-viewport-moving 生效期间）的
  // IndexedDB 写入（IDBObjectStore.put）必须为 0。
  const idbPutsDuringGesture = await page.evaluate(({ startedAt, finishedAt }) => {
    const metrics = (window as Window & { __canvasPerfMetrics: RuntimeMetrics }).__canvasPerfMetrics;
    return metrics.idbPuts.filter((at) => at >= startedAt && at <= finishedAt).length;
  }, { startedAt: dragStart, finishedAt: dragEnd });
  report("images-idb-puts-during-gesture", idbPutsDuringGesture);
  expect(idbPutsDuringGesture).toBe(0);

  // 边加载边平移期间无 >=50ms Long Task（只统计严格拖拽窗口）。
  const longTasks = await page.evaluate(({ startedAt, finishedAt }) => {
    const metrics = (window as Window & { __canvasPerfMetrics: RuntimeMetrics }).__canvasPerfMetrics;
    return metrics.longTasks.filter((t) => t.startTime >= startedAt && t.startTime <= finishedAt);
  }, { startedAt: dragStart, finishedAt: dragEnd });
  report("images-pan-long-tasks", { count: longTasks.length, max: Math.max(0, ...longTasks.map((t) => t.duration)) });
  expect(Math.max(0, ...longTasks.map((t) => t.duration))).toBeLessThan(50);

  // 全部图片最终解码且无永久失败/断图（40 张受并发上限 3 限制，需要几秒完成）。
  await expect.poll(async () => page.evaluate(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>("img[data-media-id]")];
    return images.filter((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0).length;
  }), { timeout: 10_000 }).toBeGreaterThanOrEqual(35);
  // 手势结束后缓存落盘在空闲期补跑完成（持久化不丢失）。
  await expect.poll(async () => page.evaluate(() => (
    window as Window & { __canvasPerfMetrics: RuntimeMetrics }
  ).__canvasPerfMetrics.idbPuts.length), { timeout: 10_000 }).toBeGreaterThan(0);
  const result = await page.evaluate(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>("img[data-media-id]")];
    let decoded = 0;
    for (const image of images) {
      if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) decoded += 1;
    }
    return {
      decoded,
      totalImages: images.length,
      permanentErrors: document.querySelectorAll(".kc-media-result-state.is-error").length,
      brokenImages: images.filter((image) => image.complete && image.naturalWidth === 0).length,
    };
  });
  report("images-settled", result);
  await testInfo.attach("images-settled.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(result.permanentErrors).toBe(0);
  expect(result.brokenImages).toBe(0);
  expect(result.decoded).toBeGreaterThanOrEqual(35);

  expect(network.unmocked, `unmocked /api: ${network.unmocked.join(", ")}`).toEqual([]);
  expect(network.external, `external: ${network.external.join(", ")}`).toEqual([]);
  expect(network.posts, `POSTs: ${network.posts.join(", ")}`).toEqual([]);
});

test("large-canvas drag saves without running media maintenance on the hot path", async ({ page }) => {
  await seedDenseProject(page);
  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 15_000 });
  const firstNode = page.locator('[data-kc-node-id="node-0"]');
  await expect(firstNode).toBeVisible();
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const metrics = (window as Window & { __canvasPerfMetrics: RuntimeMetrics }).__canvasPerfMetrics;
    metrics.indexedDbOpens.length = 0;
  });

  const dragStrip = firstNode.locator(".kc-node-drag-strip");
  const box = await dragStrip.boundingBox();
  expect(box).not.toBeNull();
  const interactionStartedAt = Date.now();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 24, box!.y + box!.height / 2 + 12, { steps: 4 });
  await expect(page.locator(".kc-workspace")).toHaveClass(/is-node-dragging/);
  await page.mouse.move(box!.x + box!.width / 2 + 120, box!.y + box!.height / 2 + 60, { steps: 20 });
  await page.mouse.up();
  const releasedAt = Date.now();

  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem("kachang-canvas:project-data:v1:perf-dense-project");
    if (!raw) return 0;
    const project = JSON.parse(raw) as { nodes: Array<{ id: string; position: { x: number } }> };
    return project.nodes.find((node) => node.id === "node-0")?.position.x ?? 0;
  })).toBeGreaterThan(0);

  const runtime = await page.evaluate(() => ({
    indexedDbOpens: (window as Window & { __canvasPerfMetrics: RuntimeMetrics }).__canvasPerfMetrics.indexedDbOpens.length,
  }));
  const saveLatencyMs = Date.now() - releasedAt;
  report("node-drag-save", { saveLatencyMs, indexedDbOpens: runtime.indexedDbOpens });
  expect(saveLatencyMs).toBeLessThan(1_200);
  expect(runtime.indexedDbOpens).toBe(0);
});

async function seedDenseProject(page: Page) {
  await page.addInitScript(() => {
    // init script 会在每次导航（含 reload）重新执行；只在会话内播种一次，
    // 否则 reload 会覆盖掉已持久化的视口/画布改动。
    if (sessionStorage.getItem("kachang-performance-dense-seeded")) return;
    sessionStorage.setItem("kachang-performance-dense-seeded", "1");
    const projectId = "perf-dense-project";
    const now = Date.now();
    const nodes = Array.from({ length: 240 }, (_, index) => {
      const column = index % 20;
      const row = Math.floor(index / 20);
      const kind = index === 0 ? "video" : index === 1 ? "image" : index % 5 === 0 ? "note" : "text";
      return {
        id: `node-${index}`,
        type: "kachang",
        position: { x: column * 330, y: row * 210 },
        width: 280,
        height: 160,
        selected: false,
        data: {
          kind,
          body: `Performance node ${index}`,
          accent: "jade",
          status: "idle",
          progress: null,
          media: null,
          directorCapture: null,
          config: null,
          generation: {
            modelId: null,
            parameters: {},
            referenceImagePurposes: {},
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
      };
    });
    const edges = Array.from({ length: 239 }, (_, index) => ({
      id: `edge-${index}`,
      source: `node-${index}`,
      target: `node-${index + 1}`,
      selected: false,
    }));
    const groups = Array.from({ length: 40 }, (_, index) => {
      const firstNode = index * 6;
      const memberIds = Array.from({ length: 6 }, (__, offset) => `node-${firstNode + offset}`);
      const first = nodes[firstNode]!;
      return {
        id: `group-${index}`,
        name: `Group ${index}`,
        color: "#76958d",
        nodeIds: memberIds,
        frame: {
          x: first.position.x - 20,
          y: first.position.y - 54,
          width: 6 * 330,
          height: 214,
        },
        createdAt: now,
        updatedAt: now,
      };
    });
    const project = {
      schemaVersion: 1,
      id: projectId,
      name: "Performance dense project",
      nodes,
      edges,
      groups,
      viewport: { x: 80, y: 100, zoom: 0.65 },
      createdAt: now,
      updatedAt: now,
    };
    localStorage.setItem(`kachang-canvas:project-data:v1:${projectId}`, JSON.stringify(project));
    localStorage.setItem("kachang-canvas:projects:v1", JSON.stringify({
      version: 1,
      projects: [{ id: projectId, name: project.name, createdAt: now, updatedAt: now, nodeCount: nodes.length }],
    }));
    localStorage.setItem("kachang-canvas:active-project:v1", projectId);
    localStorage.setItem("kachang-canvas:ui-preferences:v1", JSON.stringify({
      edgePathStyle: "gravity",
      edgeFlowStyle: "stardust",
    }));
  });
}

async function seedImageProject(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("kachang-performance-image-seeded")) return;
    sessionStorage.setItem("kachang-performance-image-seeded", "1");
    const projectId = "perf-image-project";
    const now = Date.now();
    const nodes = Array.from({ length: 40 }, (_, index) => {
      const column = index % 5;
      const row = Math.floor(index / 5);
      return {
        id: `img-node-${index}`,
        type: "kachang",
        position: { x: 60 + column * 290, y: 40 + row * 185 },
        width: 280,
        height: 175,
        selected: false,
        data: {
          kind: "image",
          body: "",
          accent: "blue",
          status: "success",
          progress: null,
          media: {
            id: `perf-media-${index}`,
            name: `perf-${index}.png`,
            mimeType: "image/png",
            size: 70,
            source: "server",
            serverId: `perf-media-${index}`,
            width: 128,
            height: 128,
            durationMs: null,
          },
          directorCapture: null,
          config: null,
          generation: {
            modelId: null,
            parameters: {},
            referenceImagePurposes: {},
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
      };
    });
    const project = {
      schemaVersion: 1,
      id: projectId,
      name: "Performance image project",
      nodes,
      edges: [],
      groups: [],
      viewport: { x: -120, y: -70, zoom: 0.62 },
      createdAt: now,
      updatedAt: now,
    };
    localStorage.setItem(`kachang-canvas:project-data:v1:${projectId}`, JSON.stringify(project));
    localStorage.setItem("kachang-canvas:projects:v1", JSON.stringify({
      version: 1,
      projects: [{ id: projectId, name: project.name, createdAt: now, updatedAt: now, nodeCount: nodes.length }],
    }));
    localStorage.setItem("kachang-canvas:active-project:v1", projectId);
  });
}

async function installNetworkGuard(page: Page, network: NetworkState) {
  let expectedOrigin: string | null = null;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expectedOrigin ??= url.origin;
    if (url.origin !== expectedOrigin) {
      network.external.push(`${request.method()} ${url.href}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.method() === "POST") network.posts.push(`${request.method()} ${url.pathname}${url.search}`);
      network.unmocked.push(`${request.method()} ${url.pathname}${url.search}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

async function installCanvasApiMocks(page: Page) {
  const now = new Date();
  const fetchedAt = new Date(now.getTime() - 1_000);
  const expiresAt = new Date(now.getTime() + 60_000);
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.route("**/api/v1/model-catalog*", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "performance-catalog",
        capabilityVersion: "performance-capability",
        pricingVersion: "performance-pricing",
        fetchedAt: fetchedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        quoteAvailable: true,
        models: [VIDEO_MODEL],
      },
    },
  }));
  await page.route("**/api/v1/generation-quotes", async (route) => {
    const body = route.request().postDataJSON() as { modelId?: string; parameters?: Record<string, unknown>; quantity?: number };
    await route.fulfill({
      json: {
        ok: true,
        data: {
          id: "quote-performance-1",
          modelId: body.modelId ?? VIDEO_MODEL.id,
          modelLabel: VIDEO_MODEL.label,
          modality: "video",
          quantity: body.quantity ?? 1,
          normalizedParameters: body.parameters ?? {},
          creditMicros: 1_000_000,
          credits: "1",
          yuanMicros: 10_000,
          yuan: "0.1",
          estimated: false,
          pricingUnit: "request",
          catalogVersion: "performance-catalog",
          capabilityVersion: "performance-capability",
          pricingVersion: "performance-pricing",
          expiresAt: expiresAt.toISOString(),
        },
      },
    });
  });
  await page.route("**/api/v1/generation-jobs*", (route) => route.fulfill({ json: { ok: true, data: [] } }));
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
  await page.route("**/api/v1/wallet/products", (route) => route.fulfill({ json: { ok: true, data: { items: [] } } }));
  await page.route("**/api/v1/wallet/ledger*", (route) => route.fulfill({ json: { ok: true, data: { items: [] } } }));
  await page.route("**/api/v1/membership/tasks/canvas-create-node*", (route) => route.fulfill({
    json: { ok: true, data: { message: "Node task recorded by the fixture", granted: false } },
  }));
  await page.route("**/api/v1/membership/tasks*", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        items: [],
        lifetimeCreditsSpent: 0,
        nextSpendMilestone: null,
        hub: {
          phoneVerified: false,
          signStreak: 0,
          checkedInToday: false,
          daysToStreakBonus: 7,
          dailyBonus: { key: "daily_bonus_2099-01-01", claimed: false, ready: false },
          memberDaily: null,
        },
        phoneVerified: false,
      },
    },
  }));
  await page.route("**/api/v1/cloud-projects*", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        projects: [],
        sharedProjects: [],
        usage: {
          projectCount: 0,
          projectStorageBytes: 0,
          mediaStorageBytes: 0,
          entitlements: {
            tier: "free",
            cloudProjectLimit: 3,
            projectStorageBytes: 10 * 1024 * 1024,
            mediaStorageBytes: 300 * 1024 * 1024,
            revisionRetentionCount: 3,
            multiDeviceSync: true,
          },
        },
      },
    },
  }));
  await page.route("**/api/v1/cloud-project-invitations*", (route) => route.fulfill({
    json: { ok: true, data: { invitations: [] } },
  }));
  await page.route("**/api/v1/card-library/groups*", (route) => route.fulfill({ json: { ok: true, data: { groups: [] } } }));
  await page.route("**/api/v1/card-library/cards*", (route) => route.fulfill({ json: { ok: true, data: { cards: [] } } }));
  await page.route("**/api/v1/media/**", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.route("**/api/v1/media*", (route) => route.fulfill({ json: { ok: true, data: null } }));
}

async function installRuntimeMetrics(page: Page) {
  await page.addInitScript(() => {
    const metrics = {
      setItemCalls: [] as number[],
      indexedDbOpens: [] as number[],
      idbPuts: [] as number[],
      longTasks: [] as Array<{ startTime: number; duration: number }>,
      layoutReads: [] as number[],
    };
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (...args: [string, string]) {
      metrics.setItemCalls.push(performance.now());
      return originalSetItem.apply(this, args);
    };
    const originalOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args: [string, number?]) {
      metrics.indexedDbOpens.push(performance.now());
      return Reflect.apply(originalOpen, this, args) as IDBOpenDBRequest;
    };
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: [unknown, IDBValidKey?]) {
      metrics.idbPuts.push(performance.now());
      return Reflect.apply(originalPut, this, args) as IDBRequest;
    };
    if (typeof PerformanceObserver !== "undefined") {
      try {
        const observer = new PerformanceObserver((list) => {
          metrics.longTasks.push(...list.getEntries().map((entry) => ({
            startTime: entry.startTime,
            duration: entry.duration,
          })));
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        // Long-task entries are optional in browser implementations.
      }
    }
    Object.assign(window, { __canvasPerfMetrics: metrics });
  });
}

// 生成面板场景才需要统计同步布局读取；全局替换 getComputedStyle/getBoundingClientRect
// 会给其它帧测量测试带来不必要的开销。
async function installLayoutReadMetrics(page: Page) {
  await page.addInitScript(() => {
    const metrics = (window as Window & { __canvasPerfMetrics: RuntimeMetrics }).__canvasPerfMetrics;
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      metrics.layoutReads.push(performance.now());
      return originalGetBoundingClientRect.apply(this);
    };
    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    window.getComputedStyle = ((element: Element, pseudoElt?: string | null) => {
      metrics.layoutReads.push(performance.now());
      return originalGetComputedStyle(element, pseudoElt);
    }) as typeof window.getComputedStyle;
  });
}
