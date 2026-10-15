import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import { addCanvasNode } from "./canvas-ui.fixture";

type NetworkState = { unmocked: string[]; external: string[] };

const REFERENCE_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">' +
    '<rect width="960" height="540" fill="#151515"/>' +
    '<circle cx="480" cy="270" r="96" fill="#f4f4f4"/></svg>',
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

/**
 * 输入框在上方时，节点功能栏让到节点下面去。
 *
 * 用户 2026-10-15：「输入框在上面的时候，节点上方的功能栏会被挡住，此时应该
 * 功能栏到下面去」。判据就是两件事：功能栏真的在节点下缘之下，且和输入框不再
 * 压在一起（分居节点两侧）。反过来，输入框贴节点下方时功能栏照旧留在上面。
 */
test("the node toolbar drops below the node once the composer is flipped above it", async ({
  page,
}, testInfo) => {
  await installNetworkGuard(page, { unmocked: [], external: [] });
  await installCanvasApiMocks(page);
  await page.addInitScript(seedSingleNodeGraph, { nodeY: 560 });
  await page.goto("/canvas");
  await expect(page.locator(".wc-canvas-entry-loader")).toHaveCount(0, { timeout: 5_000 });

  const node = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  await node.locator(".wc-node-drag-strip").click();

  const composer = page.locator(".wc-node-prompt-shell");
  await expect(composer).toBeVisible();
  // 视口下沿放不下输入框（节点下缘 791px、输入框至少 168px 高），所以它翻到上方。
  await expect(composer).toHaveAttribute("data-placement", "above");
  await assertToolbarDroppedBelowNode(page, node, composer, testInfo);
});

test("the node toolbar stays above while the composer still fits below", async ({ page }) => {
  await installNetworkGuard(page, { unmocked: [], external: [] });
  await installCanvasApiMocks(page);
  await page.addInitScript(seedSingleNodeGraph, { nodeY: 60 });
  await page.goto("/canvas");
  await expect(page.locator(".wc-canvas-entry-loader")).toHaveCount(0, { timeout: 5_000 });

  const node = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  await node.locator(".wc-node-drag-strip").click();

  const composer = page.locator(".wc-node-prompt-shell");
  await expect(composer).toBeVisible();
  await expect(composer).toHaveAttribute("data-placement", "below");

  const toolbar = page.locator("[data-canvas-node-toolbar]");
  await expect(toolbar).toHaveAttribute("data-placement", "above");
  const toolbarBox = await toolbar.boundingBox();
  const nodeBox = await node.boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(nodeBox).not.toBeNull();
  expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(nodeBox!.y + 1);
});

async function assertToolbarDroppedBelowNode(
  page: Page,
  node: Locator,
  composer: Locator,
  testInfo: TestInfo,
) {
  const toolbar = page.locator("[data-canvas-node-toolbar]");
  await expect(toolbar).toHaveAttribute("data-placement", "below");
  await expect(toolbar).toBeVisible();
  await page.waitForTimeout(200);

  const toolbarBox = await toolbar.boundingBox();
  const nodeBox = await node.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(nodeBox).not.toBeNull();
  expect(composerBox).not.toBeNull();

  // 功能栏挂在节点下缘之下，输入框在节点之上：两者不再争同一块地方。
  expect(toolbarBox!.y).toBeGreaterThanOrEqual(nodeBox!.y + nodeBox!.height - 1);
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(nodeBox!.y + 1);
  expect(toolbarBox!.y).toBeGreaterThanOrEqual(composerBox!.y + composerBox!.height);
  // 让下来之后仍然整条可见可点，不是被视口下沿切掉一半。
  expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(900);

  await page.screenshot({
    path: testInfo.outputPath("toolbar-below-composer.png"),
    fullPage: false,
  });
}

/**
 * 单个图片节点摆在固定流坐标上（zoom 1、平移 40/40），这样它在屏幕上的位置就是
 * 确定的：nodeY=560 → 屏幕 620..811（输入框放不下，翻到上方）；
 * nodeY=60 → 屏幕 100..291（输入框照旧在下方）。
 */
function seedSingleNodeGraph({ nodeY }: { nodeY: number }) {
  const now = Date.now();
  const project = {
    schemaVersion: 1,
    id: "generation-panel-toolbar-flip",
    name: "功能栏让位画布",
    nodes: [
      {
        id: "flip-image",
        type: "weftcanvas",
        position: { x: 60, y: nodeY },
        width: 340,
        height: 191,
        data: {
          kind: "image",
          body: "16:9 · 人像特写",
          accent: "blue",
          status: "idle",
          progress: null,
          media: null,
          directorCapture: null,
          config: null,
          edit: null,
          music: null,
          generation: {
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
          },
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
    edges: [],
    groups: [],
    viewport: { x: 40, y: 40, zoom: 1 },
    createdAt: now,
    updatedAt: now,
  };
  localStorage.setItem("weftcanvas:active-project:v1", project.id);
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
          nodeCount: 1,
        },
      ],
    }),
  );
}

test("generation panel geometry holds with one real reference connection at 1440x900 and 1024x768", async ({
  page,
}, testInfo) => {
  const network: NetworkState = { unmocked: [], external: [] };
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installNetworkGuard(page, network);
  await installCanvasApiMocks(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("weftcanvas-geometry-viewport-e2e-cleaned")) return;
    localStorage.clear();
    sessionStorage.setItem("weftcanvas-geometry-viewport-e2e-cleaned", "1");
  });
  await page.addInitScript(seedStarterGraph);

  await page.goto("/canvas");
  await expect(page.locator(".wc-canvas-entry-loader")).toHaveCount(0, { timeout: 5_000 });
  const nodes = page.locator(".react-flow__node-weftcanvas");
  await expect(nodes).toHaveCount(3);

  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  await imageNode.locator('input[type="file"]').setInputFiles({
    name: "geometry-reference.svg",
    mimeType: "image/svg+xml",
    buffer: REFERENCE_SVG,
  });
  await expect(imageNode.locator("img")).toBeVisible();

  // 创建栏的节点类型是菜单项（role="menuitem"），统一走 fixture 里那条悬浮展开
  // 再落下一项的手势；按 button 找它找不到。
  await addCanvasNode(page, "添加视频节点");
  const edges = page.locator(".react-flow__edge");
  await expect(nodes).toHaveCount(4);
  await expect(edges).toHaveCount(2);

  const videoNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])',
  );
  const sourceCore = imageNode.locator(".wc-node-port-zone--right .wc-node-port-core");
  await imageNode.hover();
  await expect(sourceCore).toBeVisible();
  const sourceBox = await sourceCore.boundingBox();
  const targetSurface = videoNode.locator(".wc-node-surface");
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

  await videoNode.locator(".wc-node-drag-strip").click();
  const settings = page.getByLabel("视频节点创作设置");
  await expect(settings).toBeVisible();
  // 输入框底部的紧凑栏用分类选择器（不是 GenerationModelSelect 的隐藏 input），
  // 选中的模型就看它触发按钮上的文案。
  await expect(settings.locator(".wc-generation-model-control")).toContainText(
    "Geometry Video Pro",
  );

  const rail = page.locator(".wc-node-reference-chips");
  await expect(rail).toBeVisible();
  await expect(rail.locator(".wc-node-reference-chip")).toHaveCount(1);
  // 素材连接只看上面这条 rail：底部状态行现在只报上游文本/错误，参考图连接不在那儿出现。

  const composer = page.getByLabel("视频节点编辑器");
  await composer.locator("[data-prompt-editor]").fill("雨夜霓虹，人物在渡口奔跑");
  await expect(settings.locator(".wc-generation-compact-credit")).toBeVisible();

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
  expect(
    geometry.documentOverflowX,
    `horizontal document overflow at ${viewport.width}x${viewport.height}`,
  ).toBe(false);
  expect(geometry.clippedLabels, `clipped labels at ${viewport.width}x${viewport.height}`).toEqual(
    [],
  );
  expect(geometry.overlaps, `incoherent overlaps at ${viewport.width}x${viewport.height}`).toEqual(
    [],
  );
  expect(geometry.controls[".wc-node-reference-chip"], "reference chip count").toHaveLength(1);

  for (const [selector, controls] of Object.entries(geometry.controls)) {
    for (const [index, control] of controls.entries()) {
      const label = `${selector}[${index}] at ${viewport.width}x${viewport.height}`;
      expect(control.box.width, `${label} width`).toBeGreaterThan(0);
      expect(control.box.height, `${label} height`).toBeGreaterThan(0);
      expect(control.inside, `${label} inside viewport ${JSON.stringify(control.box)}`).toBe(true);
      // 只对真正的交互控件要求"中心点可点"：参考素材栏、紧凑栏这些是被动容器，
      // 它们大半是空白，要求容器中心能接住指针等于让空白去接，不是真需求。
      if (control.clickable === null) continue;
      expect(control.clickable, `${label} clickable at its center`).toBe(true);
    }
  }

  if (viewport.width === 1024 && viewport.height === 768) {
    const submit = geometry.controls[".wc-generation-submit--compact"][0];
    const quick = geometry.controls[".wc-generation-quick-controls"][0];
    const bar = geometry.controls[".wc-generation-compact-bar"][0];
    expect(submit, "submit button measured").toBeDefined();
    expect(quick, "quick controls measured").toBeDefined();
    expect(bar, "compact bar measured").toBeDefined();
    expect(submit.box.bottom, "submit bottom at 1024x768").toBeLessThanOrEqual(768);
    expect(quick.box.bottom, "quick-control bottom at 1024x768").toBeLessThanOrEqual(768);
    expect(768 - submit.box.bottom, "submit bottom margin at 1024x768").toBeGreaterThanOrEqual(8);
    expect(
      768 - quick.box.bottom,
      "quick-control bottom margin at 1024x768",
    ).toBeGreaterThanOrEqual(8);
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
      ".wc-node-reference-chips",
      ".wc-node-reference-chip",
      ".wc-generation-compact-bar",
      ".wc-generation-model-control",
      ".wc-generation-quick-controls",
      ".wc-generation-parameter-control",
      ".wc-generation-more-wrap",
      ".wc-generation-submit-area",
      ".wc-generation-submit--compact",
      ".wc-generation-compact-status",
    ];
    const labelSelectors = [
      ".wc-generation-model-control .wc-canvas-select-label",
      ".wc-generation-quick-controls small",
      ".wc-generation-quick-controls .wc-canvas-select-label",
      ".wc-generation-compact-credit",
      ".wc-generation-submit--compact span",
      ".wc-generation-compact-status span",
      ".wc-node-reference-chips-header",
      ".wc-node-reference-chip b",
    ];
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const controls: Record<
      string,
      Array<{
        box: {
          left: number;
          top: number;
          right: number;
          bottom: number;
          width: number;
          height: number;
        };
        inside: boolean;
        clickable: boolean | null;
      }>
    > = {};
    const interactiveSelector =
      'button, input, select, textarea, a[href], [role="button"], [role="tab"], [role="menuitem"]';
    for (const selector of controlSelectors) {
      controls[selector] = [...root.querySelectorAll(selector)].filter(isVisible).map((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return {
          box: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
          inside:
            rect.left >= -1 &&
            rect.top >= -1 &&
            rect.right <= viewport.width + 1 &&
            rect.bottom <= viewport.height + 1,
          clickable: element.matches(interactiveSelector)
            ? hit !== null && (element === hit || element.contains(hit))
            : null,
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
          clippedLabels.push(
            `${selector}: ${(element.textContent || "").trim() || element.className}`,
          );
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

  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.route("**/api/v1/model-catalog*", (route) =>
    route.fulfill({
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
    }),
  );
  await page.route("**/api/v1/generation-quotes", async (route) => {
    const body = route.request().postDataJSON() as {
      modelId?: string;
      parameters?: Record<string, unknown>;
      quantity?: number;
    };
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
  await page.route("**/api/v1/generation-jobs*", (route) =>
    route.fulfill({ json: { ok: true, data: [] } }),
  );
  await page.route("**/api/v1/wallet", (route) =>
    route.fulfill({
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
    }),
  );
  await page.route("**/api/v1/wallet/products", (route) =>
    route.fulfill({ json: { ok: true, data: { items: [] } } }),
  );
  await page.route("**/api/v1/wallet/ledger*", (route) =>
    route.fulfill({ json: { ok: true, data: { items: [] } } }),
  );
  await page.route("**/api/v1/membership/tasks/canvas-create-node*", (route) =>
    route.fulfill({
      json: { ok: true, data: { message: "Node task recorded by the fixture", granted: false } },
    }),
  );
  await page.route("**/api/v1/membership/tasks*", (route) =>
    route.fulfill({
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
    }),
  );
  await page.route("**/api/v1/cloud-projects*", (route) =>
    route.fulfill({
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
    }),
  );
  await page.route("**/api/v1/cloud-project-invitations*", (route) =>
    route.fulfill({
      json: { ok: true, data: { invitations: [] } },
    }),
  );
  await page.route("**/api/v1/media/**", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.route("**/api/v1/media*", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
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
  const nodeData = (
    kind: "text" | "config" | "image",
    overrides: Record<string, unknown> = {},
  ) => ({
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
        type: "weftcanvas",
        position: { x: 40, y: 40 },
        width: 308,
        height: 176,
        data: nodeData("text", { body: "低机位跟拍，湿润石板路反射零散霓虹。" }),
      },
      {
        id: "starter-config",
        type: "weftcanvas",
        position: { x: 40, y: 260 },
        width: 308,
        height: 176,
        data: nodeData("config"),
      },
      {
        id: "starter-image",
        type: "weftcanvas",
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
  localStorage.setItem("weftcanvas:active-project:v1", project.id);
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
}
