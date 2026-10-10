import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

type NetworkState = { unmocked: string[]; external: string[] };

const REFERENCE_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">'
  + '<rect width="960" height="540" fill="#151515"/>'
  + '<circle cx="480" cy="270" r="96" fill="#f4f4f4"/></svg>',
);

const VIDEO_MODEL = {
  id: "geometry-video-1",
  label: "Geometry Video Pro",
  description: "确定性桌面几何验收视频模型",
  modality: "video",
  operation: "video.generate",
  order: 1,
  input: { textRequired: true, images: { min: 0, max: 1, multiple: false } },
  output: { type: "video", minCount: 1, maxCount: 1 },
  parameters: [
    { name: "aspect_ratio", label: "画面比例", type: "string", required: false, default: "16:9", options: ["16:9", "9:16"], mutuallyExclusiveWith: [] },
    { name: "duration", label: "时长（秒）", type: "integer", required: false, default: 5, options: [5, 10], mutuallyExclusiveWith: [] },
    { name: "resolution", label: "分辨率", type: "string", required: false, default: "720p", options: ["720p", "1080p"], mutuallyExclusiveWith: [] },
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

test("generation panel geometry holds with one real reference connection at 1440x900 and 1024x768", async ({ page }, testInfo) => {
  const network: NetworkState = { unmocked: [], external: [] };
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installNetworkGuard(page, network);
  await installCanvasApiMocks(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("kachang-geometry-viewport-e2e-cleaned")) return;
    localStorage.clear();
    sessionStorage.setItem("kachang-geometry-viewport-e2e-cleaned", "1");
  });
  await page.addInitScript(seedStarterGraph);

  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 5_000 });
  const nodes = page.locator(".react-flow__node-kachang");
  await expect(nodes).toHaveCount(3);

  const imageNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="image"])');
  await imageNode.locator('input[type="file"]').setInputFiles({
    name: "geometry-reference.svg",
    mimeType: "image/svg+xml",
    buffer: REFERENCE_SVG,
  });
  await expect(imageNode.locator("img")).toBeVisible();

  const creation = page.getByRole("navigation", { name: "创建工具" });
  await creation.getByRole("button", { name: "添加视频节点" }).click();
  const edges = page.locator(".react-flow__edge");
  await expect(nodes).toHaveCount(4);
  await expect(edges).toHaveCount(2);

  const videoNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="video"])');
  const sourceCore = imageNode.locator(".kc-node-port-zone--right .kc-node-port-core");
  await imageNode.hover();
  await expect(sourceCore).toBeVisible();
  const sourceBox = await sourceCore.boundingBox();
  const targetSurface = videoNode.locator(".kc-node-surface");
  const targetBox = await targetSurface.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  const sourcePoint = {
    x: sourceBox!.x + sourceBox!.width / 2,
    y: sourceBox!.y + sourceBox!.height / 2,
  };
  const targetPoint = {
    x: targetBox!.x + targetBox!.width / 2,
    y: targetBox!.y + targetBox!.height / 2,
  };
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 14 });
  await page.mouse.up();

  await expect(edges).toHaveCount(3);

  await videoNode.locator(".kc-node-drag-strip").click();
  const settings = page.getByLabel("视频节点创作设置");
  await expect(settings).toBeVisible();
  await expect(settings.locator("[data-generation-model-select]")).toHaveValue("geometry-video-1");

  const rail = page.locator(".kc-node-reference-chips");
  await expect(rail).toBeVisible();
  await expect(rail.locator(".kc-node-reference-chip")).toHaveCount(1);
  await expect(settings.locator(".kc-generation-compact-status.is-linked")).toBeVisible();

  const composer = page.getByLabel("视频节点编辑器");
  await composer.locator("[data-prompt-editor]").fill("雨夜霓虹，人物在渡口奔跑");
  await expect(settings.locator(".kc-generation-compact-credit")).toBeVisible();

  await assertGenerationPanelGeometry(page, composer, { width: 1440, height: 900 }, testInfo);
  await assertGenerationPanelGeometry(page, composer, { width: 1024, height: 768 }, testInfo);

  expect(network.unmocked, `unmocked /api requests: ${network.unmocked.join(", ")}`).toEqual([]);
  expect(network.external, `external network requests: ${network.external.join(", ")}`).toEqual([]);
  expect(pageErrors).toEqual([]);
});

async function assertGenerationPanelGeometry(
  page: Page,
  composer: Locator,
  viewport: { width: number; height: number },
  testInfo: TestInfo,
) {
  await page.setViewportSize(viewport);
  await expect(composer).toBeVisible();
  await page.waitForTimeout(200);

  const geometry = await readGenerationPanelGeometry(composer);
  expect(geometry.documentOverflowX, `horizontal document overflow at ${viewport.width}x${viewport.height}`).toBe(false);
  expect(geometry.clippedLabels, `clipped labels at ${viewport.width}x${viewport.height}`).toEqual([]);
  expect(geometry.overlaps, `incoherent overlaps at ${viewport.width}x${viewport.height}`).toEqual([]);
  expect(geometry.controls[".kc-node-reference-chip"], "reference chip count").toHaveLength(1);

  for (const [selector, controls] of Object.entries(geometry.controls)) {
    for (const [index, control] of controls.entries()) {
      const label = `${selector}[${index}] at ${viewport.width}x${viewport.height}`;
      expect(control.box.width, `${label} width`).toBeGreaterThan(0);
      expect(control.box.height, `${label} height`).toBeGreaterThan(0);
      expect(control.inside, `${label} inside viewport ${JSON.stringify(control.box)}`).toBe(true);
      expect(control.clickable, `${label} clickable at its center`).toBe(true);
    }
  }

  if (viewport.width === 1024 && viewport.height === 768) {
    const submit = geometry.controls[".kc-generation-submit--compact"][0];
    const quick = geometry.controls[".kc-generation-quick-controls"][0];
    const bar = geometry.controls[".kc-generation-compact-bar"][0];
    expect(submit, "submit button measured").toBeDefined();
    expect(quick, "quick controls measured").toBeDefined();
    expect(bar, "compact bar measured").toBeDefined();
    expect(submit.box.bottom, "submit bottom at 1024x768").toBeLessThanOrEqual(768);
    expect(quick.box.bottom, "quick-control bottom at 1024x768").toBeLessThanOrEqual(768);
    expect(768 - submit.box.bottom, "submit bottom margin at 1024x768").toBeGreaterThanOrEqual(8);
    expect(768 - quick.box.bottom, "quick-control bottom margin at 1024x768").toBeGreaterThanOrEqual(8);
    expect(768 - bar.box.bottom, "compact-bar bottom margin at 1024x768").toBeGreaterThanOrEqual(8);
  }

  await page.screenshot({
    path: testInfo.outputPath(`generation-panel-${viewport.width}x${viewport.height}.png`),
    fullPage: false,
  });
}

async function readGenerationPanelGeometry(composer: Locator) {
  return composer.evaluate((root) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const controlSelectors = [
      ".kc-node-reference-chips",
      ".kc-node-reference-chip",
      ".kc-generation-compact-bar",
      ".kc-generation-model-control",
      ".kc-generation-quick-controls",
      ".kc-generation-parameter-control",
      ".kc-generation-more-wrap",
      ".kc-generation-submit-area",
      ".kc-generation-submit--compact",
      ".kc-generation-compact-status",
    ];
    const labelSelectors = [
      ".kc-generation-model-control .kc-canvas-select-label",
      ".kc-generation-quick-controls small",
      ".kc-generation-quick-controls .kc-canvas-select-label",
      ".kc-generation-compact-credit",
      ".kc-generation-submit--compact span",
      ".kc-generation-compact-status span",
      ".kc-node-reference-chips-header",
      ".kc-node-reference-chip b",
    ];
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const controls: Record<string, Array<{
      box: { left: number; top: number; right: number; bottom: number; width: number; height: number };
      inside: boolean;
      clickable: boolean;
    }>> = {};
    for (const selector of controlSelectors) {
      controls[selector] = [...root.querySelectorAll(selector)]
        .filter(isVisible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return {
            box: {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            },
            inside: rect.left >= -1 && rect.top >= -1 && rect.right <= viewport.width + 1 && rect.bottom <= viewport.height + 1,
            clickable: hit !== null && (element === hit || element.contains(hit)),
          };
        });
    }

    const allControls = [...root.querySelectorAll(controlSelectors.join(","))].filter(isVisible);
    const overlaps: string[] = [];
    for (let left = 0; left < allControls.length; left += 1) {
      for (let right = left + 1; right < allControls.length; right += 1) {
        const a = allControls[left]!;
        const b = allControls[right]!;
        if (a.contains(b) || b.contains(a)) continue;
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const horizontal = Math.min(ar.right, br.right) - Math.max(ar.left, br.left);
        const vertical = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
        if (horizontal > 1 && vertical > 1) {
          overlaps.push(`${a.className} / ${b.className}`);
        }
      }
    }

    const clippedLabels: string[] = [];
    for (const selector of labelSelectors) {
      for (const element of [...root.querySelectorAll(selector)]) {
        if (!isVisible(element)) continue;
        if (element.scrollWidth > element.clientWidth + 1) {
          clippedLabels.push(`${selector}: ${(element.textContent || "").trim() || element.className}`);
        }
      }
    }

    return {
      viewport,
      controls,
      overlaps,
      clippedLabels,
      documentOverflowX: document.documentElement.scrollWidth > viewport.width + 1,
    };
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
        version: "geometry-viewport-catalog",
        capabilityVersion: "geometry-viewport-capability",
        pricingVersion: "geometry-viewport-pricing",
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
          id: "quote-geometry-viewport-1",
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
          catalogVersion: "geometry-viewport-catalog",
          capabilityVersion: "geometry-viewport-capability",
          pricingVersion: "geometry-viewport-pricing",
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

function seedStarterGraph() {
  const now = Date.now();
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
  const nodeData = (kind: "text" | "config" | "image", overrides: Record<string, unknown> = {}) => ({
    kind,
    body: "",
    accent: kind === "image" ? "blue" : "jade",
    status: "idle",
    progress: null,
    media: null,
    directorCapture: null,
    config: kind === "config" ? { modality: "image" } : null,
    generation,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  const project = {
    schemaVersion: 1,
    id: "generation-panel-viewport-starter",
    name: "几何视口画布",
    nodes: [
      {
        id: "starter-text",
        type: "kachang",
        position: { x: 40, y: 40 },
        width: 308,
        height: 176,
        data: nodeData("text", { body: "低机位跟拍，湿润石板路反射零散霓虹。" }),
      },
      {
        id: "starter-config",
        type: "kachang",
        position: { x: 40, y: 260 },
        width: 308,
        height: 176,
        data: nodeData("config"),
      },
      {
        id: "starter-image",
        type: "kachang",
        position: { x: 440, y: 42 },
        width: 340,
        height: 191,
        data: nodeData("image", { body: "16:9 · 冷雨夜 · 暖色实景光" }),
      },
    ],
    edges: [
      { id: "starter-edge-text", source: "starter-text", target: "starter-image" },
      { id: "starter-edge-config", source: "starter-config", target: "starter-image" },
    ],
    groups: [],
    viewport: { x: 185, y: 138, zoom: 0.9 },
    createdAt: now,
    updatedAt: now,
  };
  localStorage.setItem("kachang-canvas:active-project:v1", project.id);
  localStorage.setItem(`kachang-canvas:project-data:v1:${encodeURIComponent(project.id)}`, JSON.stringify(project));
  localStorage.setItem("kachang-canvas:projects:v1", JSON.stringify({
    version: 1,
    projects: [{ id: project.id, name: project.name, createdAt: now, updatedAt: now, nodeCount: project.nodes.length }],
  }));
}
