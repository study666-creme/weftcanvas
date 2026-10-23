import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.addInitScript(() => {
    const now = Date.now();
    const generation = {
      modelId: null,
      parameters: {},
      maxOutputTokens: null,
      referenceMode: "auto",
      referenceNodeIds: [],
      jobId: "visual-effect-job",
      jobVersion: 1,
      jobCreatedAt: new Date(now).toISOString(),
      jobStatus: "running",
      error: null,
    };
    const project = {
      schemaVersion: 1,
      id: "canvas-effects-project",
      name: "Canvas effects",
      nodes: [
        {
          id: "source-text",
          type: "weftcanvas",
          position: { x: 120, y: 220 },
          selected: false,
          data: {
            kind: "text",
            body: "Motion source",
            accent: "jade",
            status: "idle",
            progress: null,
            media: null,
            directorCapture: null,
            config: null,
            generation: {
              ...generation,
              jobId: null,
              jobVersion: null,
              jobCreatedAt: null,
              jobStatus: null,
            },
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: "running-video",
          type: "weftcanvas",
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
        },
      ],
      edges: [{ id: "motion-edge", source: "source-text", target: "running-video" }],
      groups: [],
      viewport: { x: 80, y: 100, zoom: 0.9 },
      createdAt: now,
      updatedAt: now,
    };
    localStorage.clear();
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
  });
});

test("canvas effect choices animate the real generation node and active edge", async ({ page }) => {
  await page.goto("/canvas");

  const edge = page.locator('.react-flow__edge[data-id="motion-edge"]');
  const videoNode = page.locator(
    '.react-flow__node-weftcanvas[data-id="running-video"] .wc-node-wrap--video',
  );
  await expect(videoNode).toHaveClass(/wc-accent--blue/);
  await expect(videoNode).not.toHaveClass(/wc-accent--coral/);
  await page
    .locator('.react-flow__node-weftcanvas[data-id="running-video"] .wc-node-drag-strip')
    .click();
  const energy = edge.locator(".wc-edge-energy");
  await expect(edge.locator(".wc-edge-effect--stream.is-active")).toBeAttached();
  await expect
    .poll(() => energy.evaluate((element) => Number(getComputedStyle(element).opacity)))
    .toBeGreaterThan(0.5);
  await expect(energy).toHaveCSS("animation-name", "wc-edge-energy-flow");
  const edgeOffset = await energy.evaluate((element) => getComputedStyle(element).strokeDashoffset);
  await expect
    .poll(() => energy.evaluate((element) => getComputedStyle(element).strokeDashoffset))
    .not.toBe(edgeOffset);

  const scene = page.locator(".wc-video-generation-scene");
  const field = scene.locator(".wc-video-generation-field");
  const sweep = scene.locator(".wc-video-generation-sweep");
  await expect(scene).toBeVisible();
  await expect(sweep).toHaveCSS("animation-name", "wc-video-generation-sweep");

  await page.getByLabel("打开界面设置").click();
  const effects = page.locator(
    "#wc-ui-settings-panel-visual .wc-appearance-group--previews button",
  );
  await expect(effects).toHaveCount(4);

  await effects.nth(1).click();
  await expect(page.locator("html")).toHaveAttribute("data-generation-effect", "nebula");
  await expect(field).toHaveCSS("animation-name", "wc-cosmos-nebula-primary");
  await expect(sweep).toHaveCSS("animation-name", "wc-cosmos-nebula-secondary");
  await expect(scene.locator(".wc-video-generation-scan")).toBeHidden();
  const nebulaTransform = await field.evaluate((element) => getComputedStyle(element).transform);
  await expect
    .poll(() => field.evaluate((element) => getComputedStyle(element).transform))
    .not.toBe(nebulaTransform);

  await effects.nth(2).click();
  await expect(page.locator("html")).toHaveAttribute("data-generation-effect", "water");
  await expect(field).toHaveCSS("animation-name", "wc-water-generation-primary");
  await expect(sweep).toHaveCSS("animation-name", "wc-water-generation-secondary");

  await effects.nth(3).click();
  await expect(page.locator("html")).toHaveAttribute("data-generation-effect", "quiet");
  await expect(field).not.toBeAttached();
  const runningNode = page.locator('.react-flow__node-weftcanvas[data-id="running-video"]');
  const quietScene = runningNode.locator(".wc-quiet-generation-scene");
  await expect(quietScene).toBeAttached();
  await expect(quietScene.locator(".wc-quiet-generation-sweep")).toHaveCSS(
    "animation-name",
    "wc-quiet-sweep",
  );
  const quietRing = runningNode.locator(".wc-quiet-ring");
  await expect(quietRing).toBeAttached();
  await expect(runningNode.locator(".wc-node-loading-label")).toContainText("正在生成视频");
  const ringMetrics = await quietRing.evaluate((element) => {
    const ring = element as HTMLElement;
    return {
      offsetWidth: ring.offsetWidth,
      offsetHeight: ring.offsetHeight,
      boxWidth: ring.getBoundingClientRect().width,
      boxHeight: ring.getBoundingClientRect().height,
    };
  });
  expect(ringMetrics.offsetWidth).toBe(36);
  expect(ringMetrics.offsetHeight).toBe(36);
  expect(ringMetrics.boxWidth).toBeGreaterThan(0);
  expect(ringMetrics.boxHeight).toBeGreaterThan(0);
  const copyBox = await runningNode.locator(".wc-node-loading-copy").boundingBox();
  expect(copyBox).not.toBeNull();
  const railBox = await runningNode.locator(".wc-node-loading-track").boundingBox();
  expect(railBox).not.toBeNull();
  const ringBox = await quietRing.boundingBox();
  expect(ringBox).not.toBeNull();
  expect(ringBox!.y + ringBox!.height).toBeLessThanOrEqual(copyBox!.y);
  expect(copyBox!.y + copyBox!.height).toBeLessThanOrEqual(railBox!.y);
  const nodeBox = await runningNode.boundingBox();
  expect(nodeBox).not.toBeNull();
  expect(railBox!.y + railBox!.height).toBeLessThanOrEqual(nodeBox!.y + nodeBox!.height);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(quietScene.locator(".wc-quiet-generation-sweep")).toHaveCSS(
    "animation-name",
    "wc-quiet-sweep",
  );
  await expect(quietScene.locator(".wc-quiet-generation-sweep")).toHaveCSS(
    "animation-iteration-count",
    "infinite",
  );
  await expect(page.locator(".wc-node-loading-label")).toContainText("正在生成视频");
  // 减弱动效下扩散环被隐藏，但指针反馈层仍在，且原生光标必须保持可见。
  const pulse = page.getByTestId("pointer-pulse");
  await expect(pulse).toBeAttached();
  await expect(pulse.locator(".wc-pointer-pulse-ring")).toBeHidden();
  await expect(pulse).toHaveCSS("pointer-events", "none");
  expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).not.toBe("none");
  expect(
    await page.evaluate(() => document.documentElement.classList.contains("has-wc-cursor")),
  ).toBe(false);
});

test("quiet renders a calm centered generation state inside the real media node", async ({
  page,
}) => {
  await page.goto("/canvas");
  await page.getByLabel("打开界面设置").click();
  await page.getByRole("button", { name: "光环生成动效" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-generation-effect", "quiet");

  const runningNode = page.locator('.react-flow__node-weftcanvas[data-id="running-video"]');
  const loading = runningNode.locator(".wc-node-loading");
  await expect(loading).toHaveAttribute("data-generation-effect", "quiet");
  await expect(loading).toContainText("正在生成视频");
  await expect(loading).toContainText("42%");

  const ring = loading.locator(".wc-quiet-ring");
  await expect(ring).toHaveCount(1);
  const ringMetrics = await ring.evaluate((element) => {
    const ringEl = element as HTMLElement;
    return {
      offsetWidth: ringEl.offsetWidth,
      offsetHeight: ringEl.offsetHeight,
      boxWidth: ringEl.getBoundingClientRect().width,
      boxHeight: ringEl.getBoundingClientRect().height,
    };
  });
  expect(ringMetrics.offsetWidth).toBe(36);
  expect(ringMetrics.offsetHeight).toBe(36);
  expect(ringMetrics.boxWidth).toBeGreaterThan(0);
  expect(ringMetrics.boxHeight).toBeGreaterThan(0);

  const copy = loading.locator(".wc-node-loading-copy");
  const track = loading.locator(".wc-node-loading-track");
  await expect(copy).toBeVisible();
  await expect(track).toBeVisible();

  const layout = await loading.evaluate((element) => {
    const ring = element.querySelector<HTMLElement>(".wc-quiet-ring")!;
    const copy = element.querySelector<HTMLElement>(".wc-node-loading-copy")!;
    const track = element.querySelector<HTMLElement>(".wc-node-loading-track")!;
    const node = element.getBoundingClientRect();
    const rb = ring.getBoundingClientRect();
    const cb = copy.getBoundingClientRect();
    const tb = track.getBoundingClientRect();
    return {
      ringBottom: rb.bottom,
      copyTop: cb.top,
      copyBottom: cb.bottom,
      trackTop: tb.top,
      insideLeft: node.left,
      insideRight: node.right,
      insideTop: node.top,
      insideBottom: node.bottom,
    };
  });
  expect(layout.ringBottom).toBeLessThanOrEqual(layout.copyTop);
  expect(layout.copyBottom).toBeLessThanOrEqual(layout.trackTop);
  expect(layout.insideLeft).toBeLessThanOrEqual(layout.insideRight);
  expect(layout.copyBottom).toBeLessThanOrEqual(layout.insideBottom);
  expect(layout.trackTop).toBeLessThanOrEqual(layout.insideBottom);

  const nodeGeometry = await runningNode.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }));
  expect(nodeGeometry.width).toBeGreaterThan(300);
  expect(nodeGeometry.height).toBeGreaterThan(170);

  const ringBoxBefore = await ring.boundingBox();
  await page.waitForTimeout(120);
  const ringBoxAfter = await ring.boundingBox();
  expect(ringBoxAfter).not.toBeNull();
  expect(ringBoxBefore).not.toBeNull();
  expect(Math.round(ringBoxAfter!.width)).toBe(Math.round(ringBoxBefore!.width));
  expect(Math.round(ringBoxAfter!.height)).toBe(Math.round(ringBoxBefore!.height));
  const sweepBefore = await loading
    .locator(".wc-quiet-generation-sweep")
    .evaluate((element) => getComputedStyle(element).transform);
  await expect
    .poll(() =>
      loading
        .locator(".wc-quiet-generation-sweep")
        .evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe(sweepBefore);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(loading).toContainText("正在生成视频");
  await expect(ring).toBeVisible();
  await expect(loading.locator(".wc-quiet-generation-sweep")).toHaveCSS(
    "animation-name",
    "wc-quiet-sweep",
  );
  await expect
    .poll(() => ring.evaluate((element) => getComputedStyle(element, "::before").animationName))
    .toBe("wc-quiet-ring-rotate");
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("ordinary unselected connections remain static until an endpoint or edge is selected", async ({
  page,
}) => {
  await page.goto("/canvas");

  const edge = page.locator('.react-flow__edge[data-id="motion-edge"]');
  const renderer = edge.locator(
    '.wc-edge-renderer[data-edge-energy-active="false"][data-edge-energy-ambient="false"]',
  );
  await expect(renderer).toBeAttached();
  await expect(renderer.locator(".wc-edge-energy")).toHaveCount(0);
  await expect(renderer.locator(".wc-edge-effect")).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(renderer.locator(".wc-edge-effect")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("pointer feedback stays available when pointer media queries under-report it", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      if (!query.includes("any-pointer: fine")) return nativeMatchMedia(query);
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => true,
      } as MediaQueryList;
    };
  });
  await page.goto("/canvas");

  const pulse = page.getByTestId("pointer-pulse");
  await expect(pulse).toBeAttached();
  // 反馈层不参与命中，绝不挡住画布点击。
  await expect(pulse).toHaveCSS("pointer-events", "none");
  // 原生光标始终可见：不再有隐藏光标的类，也不再强制 cursor: none。
  expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).not.toBe("none");
  expect(
    await page.evaluate(() => document.documentElement.classList.contains("has-wc-cursor")),
  ).toBe(false);

  // 指针媒体查询谎报时，真实鼠标依然能触发进入反馈。
  await page.mouse.move(920, 620);
  await expect(pulse).not.toHaveClass(/is-enter|is-press/);
  const toolbarButton = page.getByLabel("打开界面设置");
  await toolbarButton.hover();
  await expect(pulse).toHaveClass(/is-enter/);
  await page.mouse.down();
  await expect(pulse).toHaveClass(/is-press/);
  await page.mouse.up();
});
