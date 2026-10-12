import { expect, test, type Locator, type Page } from "@playwright/test";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const PORT_X_OFFSET = 25;

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.route("**/api/v1/model-catalog*", (route) =>
    route.fulfill({ json: { ok: true, data: emptyCatalog() } }),
  );
  await page.route("**/api/v1/generation-jobs", (route) =>
    route.fulfill({ json: { ok: true, data: [] } }),
  );
  await page.route("**/api/v1/generation-quotes", (route) =>
    route.fulfill({ json: { ok: true, data: [] } }),
  );
  await page.route("**/api/v1/membership/tasks*", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          items: [],
          lifetimeCreditsSpent: 0,
          nextSpendMilestone: null,
          hub: null,
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
            entitlements: { tier: "free" },
          },
        },
      },
    }),
  );
  await page.route("**/api/v1/media/*/content*", (route) =>
    route.fulfill({ body: PIXEL, contentType: "image/png" }),
  );
});

type NodeGeometry = {
  frame: { x: number; y: number; width: number; height: number };
  wrap: { x: number; y: number; width: number; height: number } | null;
  surface: { x: number; y: number; width: number; height: number } | null;
  media: { x: number; y: number; width: number; height: number } | null;
  leftPort: { x: number; y: number } | null;
  rightPort: { x: number; y: number } | null;
  selection: { inset: string; border: string; opacity: string } | null;
};

async function cleanBrowser(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("weftcanvas-viewport-scale-e2e-cleaned")) return;
    localStorage.clear();
    sessionStorage.setItem("weftcanvas-viewport-scale-e2e-cleaned", "1");
  });
}

async function openCanvas(page: Page) {
  await page.goto("/canvas");
  await expect(page.locator(".wc-canvas-entry-loader")).toHaveCount(0, { timeout: 4_000 });
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
}

async function readViewport(page: Page) {
  return page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
  });
}

async function setZoom(page: Page, percent: number) {
  const slider = page.locator('.wc-zoom-control input[type="range"]');
  await slider.fill(String(percent));
  await expect.poll(async () => (await readViewport(page)).zoom).toBeCloseTo(percent / 100, 2);
}

async function measureGeometry(page: Page, node: Locator): Promise<NodeGeometry> {
  return node.evaluate((element) => {
    const rect = (value: DOMRect) => ({
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
    });
    const center = (value: DOMRect) => ({
      x: value.x + value.width / 2,
      y: value.y + value.height / 2,
    });
    const wrapElement = element.querySelector<HTMLElement>(".wc-node-wrap");
    const surfaceElement = element.querySelector<HTMLElement>(".wc-node-surface");
    const mediaElement = element.querySelector<HTMLElement>(".wc-node-media-frame");
    const leftCore = element.querySelector<HTMLElement>(
      ".wc-node-port-zone--left .wc-node-port-core",
    );
    const rightCore = element.querySelector<HTMLElement>(
      ".wc-node-port-zone--right .wc-node-port-core",
    );
    const selection = getComputedStyle(element, "::after");
    return {
      frame: rect(element.getBoundingClientRect()),
      wrap: wrapElement ? rect(wrapElement.getBoundingClientRect()) : null,
      surface: surfaceElement ? rect(surfaceElement.getBoundingClientRect()) : null,
      media: mediaElement ? rect(mediaElement.getBoundingClientRect()) : null,
      leftPort: leftCore ? center(leftCore.getBoundingClientRect()) : null,
      rightPort: rightCore ? center(rightCore.getBoundingClientRect()) : null,
      selection: {
        inset: selection.inset,
        border: selection.borderWidth,
        opacity: selection.opacity,
      },
    };
  });
}

function expectBoxesMatch(geometry: NodeGeometry, label: string) {
  expect(geometry.wrap, `${label}: wrap`).not.toBeNull();
  expect(geometry.surface, `${label}: surface`).not.toBeNull();
  for (const part of ["wrap", "surface"] as const) {
    const box = geometry[part]!;
    expect(Math.abs(box.x - geometry.frame.x), `${label}: ${part} x`).toBeLessThanOrEqual(1.5);
    expect(Math.abs(box.y - geometry.frame.y), `${label}: ${part} y`).toBeLessThanOrEqual(1.5);
    expect(
      Math.abs(box.width - geometry.frame.width),
      `${label}: ${part} width`,
    ).toBeLessThanOrEqual(1.5);
    expect(
      Math.abs(box.height - geometry.frame.height),
      `${label}: ${part} height`,
    ).toBeLessThanOrEqual(1.5);
  }
}

function expectPortsAnchored(geometry: NodeGeometry, zoom: number, label: string) {
  expect(geometry.leftPort, `${label}: left port`).not.toBeNull();
  expect(geometry.rightPort, `${label}: right port`).not.toBeNull();
  const frameCenterY = geometry.frame.y + geometry.frame.height / 2;
  const leftCore = geometry.leftPort!;
  const rightCore = geometry.rightPort!;
  expect(
    Math.abs(leftCore.x - (geometry.frame.x - PORT_X_OFFSET * zoom)),
    `${label}: left port x`,
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(rightCore.x - (geometry.frame.x + geometry.frame.width + PORT_X_OFFSET * zoom)),
    `${label}: right port x`,
  ).toBeLessThanOrEqual(2);
  expect(Math.abs(leftCore.y - frameCenterY), `${label}: left port y`).toBeLessThanOrEqual(2);
  expect(Math.abs(rightCore.y - frameCenterY), `${label}: right port y`).toBeLessThanOrEqual(2);
  expect(
    Math.abs(
      geometry.frame.x - leftCore.x - (rightCore.x - (geometry.frame.x + geometry.frame.width)),
    ),
    `${label}: port symmetry`,
  ).toBeLessThanOrEqual(1.5);
}

async function readPersistedProject(page: Page) {
  return page.evaluate(() => {
    const projectId = localStorage.getItem("weftcanvas:active-project:v1");
    if (!projectId) throw new Error("no active project");
    const raw = localStorage.getItem(`weftcanvas:project-data:v1:${encodeURIComponent(projectId)}`);
    if (!raw) throw new Error("project data missing");
    const project = JSON.parse(raw) as {
      viewport: { x: number; y: number; zoom: number };
      nodes: Array<{
        id: string;
        width?: number;
        height?: number;
        position: { x: number; y: number };
      }>;
    };
    return project;
  });
}

test("a fresh project and an explicit New Project start at the neutral 70% viewport", async ({
  page,
}, testInfo) => {
  await cleanBrowser(page);
  await openCanvas(page);

  const viewport = await readViewport(page);
  expect(viewport.zoom).toBeCloseTo(0.7, 2);
  expect(viewport.x).toBeCloseTo(720, 0);
  expect(viewport.y).toBeCloseTo(450, 0);

  const creation = page.getByRole("navigation", { name: "创建工具" });
  await creation.getByRole("button", { name: "添加文本节点" }).click();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  await page.getByLabel("项目菜单").click();
  const sidebar = page.locator(".wc-project-sidebar");
  await expect(sidebar).toBeVisible();
  await sidebar.getByLabel("新建项目").click();
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(0);

  const resetViewport = await readViewport(page);
  expect(resetViewport.zoom).toBeCloseTo(0.7, 2);
  expect(resetViewport.x).toBeCloseTo(720, 0);
  expect(resetViewport.y).toBeCloseTo(450, 0);

  await page.screenshot({ path: testInfo.outputPath("empty-70-percent-dark.png"), fullPage: true });
});

test("a newly created image node at default zoom is centered, moderate, and exposes both side add controls", async ({
  page,
}, testInfo) => {
  await cleanBrowser(page);
  await openCanvas(page);

  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("button", { name: "添加图片节点" })
    .click();
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(1);
  const node = page.locator(".react-flow__node-weftcanvas");
  await expect(node).toHaveClass(/selected/);
  await page.waitForTimeout(320);

  const box = await node.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.width)).toBeGreaterThanOrEqual(210);
  expect(Math.round(box!.width)).toBeLessThanOrEqual(270);
  expect(Math.abs(box!.x + box!.width / 2 - 720)).toBeLessThan(2);
  expect(Math.abs(box!.y + box!.height / 2 - 450)).toBeLessThan(2);

  const leftZone = node.locator(".wc-node-port-zone--left");
  const rightZone = node.locator(".wc-node-port-zone--right");
  await expect(leftZone.locator(".wc-node-port-core")).toBeVisible();
  await expect(rightZone.locator(".wc-node-port-core")).toBeVisible();
  expect(await leftZone.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  expect(await rightZone.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

  const geometry = await measureGeometry(page, node);
  expectBoxesMatch(geometry, "default-zoom image node");
  expectPortsAnchored(geometry, 0.7, "default-zoom image node");
  expect(geometry.selection?.inset).toBe("-4px");

  const leftPortBox = await leftZone.locator(".wc-node-port-core").boundingBox();
  const rightPortBox = await rightZone.locator(".wc-node-port-core").boundingBox();
  expect(leftPortBox).not.toBeNull();
  expect(rightPortBox).not.toBeNull();
  expect(leftPortBox!.x).toBeGreaterThanOrEqual(0);
  expect(rightPortBox!.x + rightPortBox!.width).toBeLessThanOrEqual(1440);
  expect(leftPortBox!.y).toBeGreaterThanOrEqual(0);
  expect(rightPortBox!.y + rightPortBox!.height).toBeLessThanOrEqual(900);

  const chrome = await page.evaluate(() => {
    const boxes = Array.from(
      document.querySelectorAll(".wc-topbar, .wc-create-rail, .wc-edit-dock"),
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
    const nodeRect = document
      .querySelector(".react-flow__node-weftcanvas .wc-node-wrap")
      ?.getBoundingClientRect();
    return {
      boxes,
      node: nodeRect
        ? { left: nodeRect.left, top: nodeRect.top, right: nodeRect.right, bottom: nodeRect.bottom }
        : null,
    };
  });
  expect(chrome.node).not.toBeNull();
  for (const area of chrome.boxes) {
    const overlaps =
      chrome.node!.left < area.right &&
      chrome.node!.right > area.left &&
      chrome.node!.top < area.bottom &&
      chrome.node!.bottom > area.top;
    expect(overlaps, `node overlaps persistent chrome ${JSON.stringify(area)}`).toBe(false);
  }

  await page.screenshot({
    path: testInfo.outputPath("centered-node-both-add-controls-dark.png"),
    fullPage: true,
  });
});

test("nodes created and local media uploaded at ten percent zoom keep normal intrinsic dimensions at one hundred percent", async ({
  page,
}, testInfo) => {
  await cleanBrowser(page);
  await openCanvas(page);
  const nodes = page.locator(".react-flow__node-weftcanvas");
  const creation = page.getByRole("navigation", { name: "创建工具" });

  await setZoom(page, 10);
  await creation.getByRole("button", { name: "添加图片节点" }).click();
  await expect(nodes).toHaveCount(1);
  await page.waitForTimeout(320);
  const overviewBox = await nodes.first().boundingBox();
  expect(overviewBox).not.toBeNull();
  expect(overviewBox!.width).toBeGreaterThanOrEqual(30);
  expect(overviewBox!.width).toBeLessThan(60);

  await creation.getByRole("button", { name: "添加图片节点" }).click();
  await expect(nodes).toHaveCount(2);
  const uploaded = nodes.nth(1);
  await uploaded
    .locator('input[type="file"]')
    .setInputFiles({ name: "overview-upload.png", mimeType: "image/png", buffer: PIXEL });
  await expect(uploaded.locator("img")).toBeVisible();

  await setZoom(page, 100);
  await page.waitForTimeout(320);
  const createdAtFull = await nodes.nth(0).boundingBox();
  const uploadedAtFull = await nodes.nth(1).boundingBox();
  expect(createdAtFull).not.toBeNull();
  expect(uploadedAtFull).not.toBeNull();
  expect(Math.round(createdAtFull!.width)).toBeGreaterThanOrEqual(330);
  expect(Math.round(createdAtFull!.width)).toBeLessThanOrEqual(400);
  expect(Math.round(uploadedAtFull!.width)).toBeGreaterThanOrEqual(330);
  expect(Math.round(uploadedAtFull!.width)).toBeLessThanOrEqual(400);
  expect(createdAtFull!.width).toBeLessThan(1440 * 0.5);
  expect(uploadedAtFull!.width).toBeLessThan(1440 * 0.5);

  await page.screenshot({
    path: testInfo.outputPath("stable-intrinsic-dims-at-full-zoom.png"),
    fullPage: true,
  });
});

test("zooming 10->25->70->100->240->70 keeps geometry aligned and never mutates persisted dimensions", async ({
  page,
}, testInfo) => {
  await cleanBrowser(page);
  await openCanvas(page);

  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("button", { name: "添加图片节点" })
    .click();
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(1);
  const node = page.locator(".react-flow__node-weftcanvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await page.waitForTimeout(320);

  const before = await readPersistedProject(page);
  expect(before.nodes).toHaveLength(1);
  const beforeWidth = before.nodes[0]!.width;
  const beforeHeight = before.nodes[0]!.height;

  for (const percent of [10, 25, 70, 100, 240, 70]) {
    await setZoom(page, percent);
    await page.waitForTimeout(320);
    const geometry = await measureGeometry(page, node);
    expectBoxesMatch(geometry, `zoom ${percent}%`);
    expectPortsAnchored(geometry, percent / 100, `zoom ${percent}%`);
    expect(geometry.selection?.inset).toBe("-4px");
    if (geometry.media) {
      expect(
        Math.abs(geometry.media.x - geometry.frame.x),
        `zoom ${percent}% media x`,
      ).toBeLessThanOrEqual(1.5);
      expect(
        Math.abs(geometry.media.y - geometry.frame.y),
        `zoom ${percent}% media y`,
      ).toBeLessThanOrEqual(1.5);
      expect(
        Math.abs(geometry.media.width - geometry.frame.width),
        `zoom ${percent}% media width`,
      ).toBeLessThanOrEqual(1.5);
      expect(
        Math.abs(geometry.media.height - geometry.frame.height),
        `zoom ${percent}% media height`,
      ).toBeLessThanOrEqual(1.5);
    }
  }

  const after = await readPersistedProject(page);
  expect(after.nodes[0]!.width).toBe(beforeWidth);
  expect(after.nodes[0]!.height).toBe(beforeHeight);
  await page.screenshot({
    path: testInfo.outputPath("zoom-roundtrip-alignment.png"),
    fullPage: true,
  });
});

test("reloading restores an explicitly saved viewport and never resets an existing project to the default", async ({
  page,
}, testInfo) => {
  await cleanBrowser(page);
  await openCanvas(page);

  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("button", { name: "添加文本节点" })
    .click();
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(1);

  await setZoom(page, 120);
  const viewportBefore = await readViewport(page);
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  const saved = await readPersistedProject(page);
  expect(saved.viewport.zoom).toBeCloseTo(1.2, 2);

  await page.reload();
  await expect(page.locator(".wc-canvas-entry-loader")).toHaveCount(0, { timeout: 4_000 });
  const restored = await readViewport(page);
  expect(restored.zoom).toBeCloseTo(1.2, 2);
  expect(Math.abs(restored.x - saved.viewport.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(restored.y - saved.viewport.y)).toBeLessThanOrEqual(1);
  expect(restored.zoom).not.toBeCloseTo(0.7, 2);

  await page.screenshot({
    path: testInfo.outputPath("restored-saved-viewport.png"),
    fullPage: true,
  });
});

test("an existing project with a saved non-default viewport loads it unchanged at a wide desktop size", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await cleanBrowser(page);
  await seedSavedProject(page, { x: 210, y: 120, zoom: 0.55 }, [
    { id: "kept-image", position: { x: 320, y: 180 }, width: 680, height: 382, media: null },
    {
      id: "kept-media",
      position: { x: 1120, y: 300 },
      width: 720,
      height: 405,
      media: { width: 1280, height: 720 },
    },
  ]);
  await openCanvas(page);

  const viewport = await readViewport(page);
  expect(viewport.zoom).toBeCloseTo(0.55, 2);
  expect(viewport.x).toBeCloseTo(210, 0);
  expect(viewport.y).toBeCloseTo(120, 0);

  const imageNode = page.locator('.react-flow__node-weftcanvas[data-id="kept-image"]');
  await imageNode.locator(".wc-node-drag-strip").click();
  await page.waitForTimeout(320);
  const geometry = await measureGeometry(page, imageNode);
  expectBoxesMatch(geometry, "wide desktop legacy node");
  expect(geometry.frame.width).toBeCloseTo(680 * 0.55, 0);
  expect(geometry.frame.height).toBeCloseTo(382 * 0.55, 0);

  const persisted = await readPersistedProject(page);
  expect(persisted.viewport).toEqual({ x: 210, y: 120, zoom: 0.55 });
  expect(persisted.nodes.find((item) => item.id === "kept-image")).toMatchObject({
    width: 680,
    height: 382,
  });
  expect(persisted.nodes.find((item) => item.id === "kept-media")).toMatchObject({
    width: 720,
    height: 405,
  });

  await page.screenshot({
    path: testInfo.outputPath("legacy-viewport-wide-dark.png"),
    fullPage: true,
  });
});

test("light mode keeps the same node frame, surface, and port geometry at default zoom", async ({
  page,
}, testInfo) => {
  await cleanBrowser(page);
  await page.addInitScript(() => {
    localStorage.setItem("weftcanvas:theme", "light");
  });
  await openCanvas(page);

  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("button", { name: "添加图片节点" })
    .click();
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(1);
  const node = page.locator(".react-flow__node-weftcanvas");
  await page.waitForTimeout(320);

  const geometry = await measureGeometry(page, node);
  expectBoxesMatch(geometry, "light mode");
  expectPortsAnchored(geometry, 0.7, "light mode");
  await page.screenshot({ path: testInfo.outputPath("light-mode-geometry.png"), fullPage: true });
});

async function seedSavedProject(
  page: Page,
  viewport: { x: number; y: number; zoom: number },
  nodes: Array<{
    id: string;
    position: { x: number; y: number };
    width: number;
    height: number;
    media: { width: number; height: number } | null;
  }>,
) {
  await page.addInitScript(
    (seed) => {
      localStorage.clear();
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
      const project = {
        schemaVersion: 1,
        id: "viewport-scale-existing",
        name: "既有项目",
        nodes: seed.nodes.map((item) => ({
          id: item.id,
          type: "weftcanvas",
          position: item.position,
          width: item.width,
          height: item.height,
          data: {
            kind: "image",
            body: "",
            accent: "blue",
            status: item.media ? "success" : "idle",
            progress: null,
            media: item.media
              ? {
                  id: `media-${item.id}`,
                  name: `${item.id}.png`,
                  mimeType: "image/png",
                  size: 1,
                  source: "local",
                  serverId: null,
                  width: item.media.width,
                  height: item.media.height,
                  durationMs: null,
                }
              : null,
            directorCapture: null,
            config: null,
            generation,
            createdAt: now,
            updatedAt: now,
          },
        })),
        edges: [],
        groups: [],
        viewport: seed.viewport,
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
    },
    { viewport, nodes },
  );
}

function emptyCatalog() {
  const now = new Date();
  return {
    ok: true,
    data: {
      version: "viewport-scale-catalog",
      capabilityVersion: "viewport-scale-capability",
      pricingVersion: "viewport-scale-pricing",
      fetchedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      quoteAvailable: false,
      models: [],
    },
  };
}
