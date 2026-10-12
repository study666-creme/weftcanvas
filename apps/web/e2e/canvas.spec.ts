import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";
import { seedStarterCanvas } from "./starter-canvas.fixture";

const videoFixture = fileURLToPath(new URL("./video-frame.mp4", import.meta.url));
const audioFixture = fileURLToPath(new URL("./audio-tone.mp3", import.meta.url));

test.beforeEach(async ({ page }) => {
  await mockAuthenticatedBackgroundApis(page);
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.route("**/api/v1/model-catalog*", (route) => {
    const now = new Date();
    return route.fulfill({
      json: {
        ok: true,
        data: {
          version: "canvas-empty-catalog",
          capabilityVersion: "canvas-empty-capability",
          pricingVersion: "canvas-empty-pricing",
          fetchedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
          quoteAvailable: false,
          models: [],
        },
      },
    });
  });
});

async function cleanProject(page: Page, options: { starter?: boolean } = {}) {
  const { starter = true } = options;
  await page.addInitScript(() => {
    if (sessionStorage.getItem("weftcanvas-e2e-cleaned")) return;
    localStorage.clear();
    sessionStorage.setItem("weftcanvas-e2e-cleaned", "1");
  });
  if (starter) {
    await seedStarterCanvas(page);
  }
}

async function openCanvas(page: Page) {
  await page.goto("/canvas");
  // The canvas is interactive once React Flow mounts. Waiting for the renderer
  // (not the boot overlay alone) covers both a warm dev server where the lazy
  // loader mounts and vanishes quickly and a cold compile where it takes a
  // while. Then require the boot overlay to be gone: it is position-fixed and
  // would swallow the scenario's pointer events while leaving.
  await expect(page.locator(".react-flow__renderer")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".wc-canvas-entry-loader")).toHaveCount(0, { timeout: 20_000 });
}

function readContentEditableCaretOffset(editor: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return -1;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.endContainer)) return -1;
  const prefix = document.createRange();
  prefix.setStart(editor, 0);
  prefix.setEnd(range.endContainer, range.endOffset);
  return prefix.toString().length;
}

test("desktop canvas supports core creation and editing flow", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await cleanProject(page);
  await openCanvas(page);

  await expect(page.getByLabel("纬线画布", { exact: true })).toBeVisible();
  const nodes = page.locator(".react-flow__node-weftcanvas");
  await expect(nodes).toHaveCount(3);

  const creation = page.getByRole("navigation", { name: "创建工具" });
  const editing = page.getByRole("navigation", { name: "编辑工具" });
  const editingBox = await editing.boundingBox();
  expect(editingBox).not.toBeNull();
  expect(Math.abs(editingBox!.x + editingBox!.width / 2 - 720)).toBeLessThan(2);

  const textNode = nodes.filter({ has: page.locator('.wc-node-wrap[data-node-kind="text"]') });
  await textNode.locator(".wc-node-drag-strip").click();
  const nodeToolbar = page.locator(".wc-node-action-toolbar");
  await expect(nodeToolbar).toBeVisible();
  await expect(page.locator(".react-flow__resize-control")).toHaveCount(0);
  await nodeToolbar.getByLabel("全屏编辑").click();
  const editDialog = page.getByRole("dialog", { name: "编辑文本节点" });
  const body = editDialog.getByLabel("节点内容");
  await expect(body).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("近景，人物停在渡口灯下。", { delay: 8 });
  await editDialog.getByLabel("收起").click();
  await expect(nodes).toHaveCount(3);
  await expect(textNode.locator(".wc-node-text-preview")).toHaveText("近景，人物停在渡口灯下。");

  await page.locator(".react-flow__pane").click({ position: { x: 1100, y: 700 } });
  await page.keyboard.press("Control+Z");
  await expect(textNode.locator(".wc-node-text-preview")).toContainText("低机位跟拍");
  await page.keyboard.press("Control+Y");
  await expect(textNode.locator(".wc-node-text-preview")).toHaveText("近景，人物停在渡口灯下。");

  await creation.getByRole("button", { name: "添加文本节点" }).click();
  await expect(nodes).toHaveCount(4);
  await page.keyboard.press("Control+Z");
  await expect(nodes).toHaveCount(3);

  expect(errors).toEqual([]);
});

test("double click expands text and media nodes into focused full-screen views", async ({
  page,
}) => {
  await cleanProject(page, { starter: false });
  await openCanvas(page);

  const creation = page.getByRole("navigation", { name: "创建工具" });
  await creation.getByRole("button", { name: "添加文本节点" }).click();
  await creation.getByRole("button", { name: "添加图片节点" }).click();
  await creation.getByRole("button", { name: "添加视频节点" }).click();
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(3);

  const textNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  await textNode.locator(".wc-node-surface").dblclick();
  await expect(page.getByRole("dialog", { name: "编辑文本节点" })).toBeVisible();
  await page.keyboard.press("Escape");

  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  await imageNode.locator('input[type="file"]').setInputFiles({
    name: "cinema-preview.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#151515"/><circle cx="480" cy="270" r="96" fill="#f4f4f4"/></svg>',
    ),
  });
  await expect(imageNode.locator("img")).toBeVisible();
  await imageNode.locator(".wc-node-surface").dblclick();

  const preview = page.locator(".wc-node-overlay--preview");
  const panel = preview.locator(".wc-node-overlay-panel--preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("img", { name: "cinema-preview.svg" })).toBeVisible();
  const panelBox = await panel.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox!.width).toBeGreaterThan(1_300);
  expect(panelBox!.height).toBeGreaterThan(780);
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);

  const videoNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])',
  );
  await videoNode.locator('input[type="file"]').setInputFiles(videoFixture);
  await expect(videoNode.locator(".wc-node-media-frame")).toHaveClass(/is-measured/);
  await expect(videoNode.locator(".wc-node-video-player > video")).toBeVisible();
  await videoNode
    .locator(".wc-node-video-player > video")
    .dblclick({ force: true, position: { x: 20, y: 20 } });

  const videoPreview = page.locator(".wc-node-overlay--preview");
  const media = videoPreview.locator(".wc-node-overlay-media");
  const video = media.locator("video");
  await expect(videoPreview).toBeVisible();
  await expect(video).toBeVisible();
  const mediaBox = await media.boundingBox();
  const videoBox = await video.boundingBox();
  expect(mediaBox).not.toBeNull();
  expect(videoBox).not.toBeNull();
  expect(videoBox!.x).toBeGreaterThanOrEqual(mediaBox!.x - 1);
  expect(videoBox!.y).toBeGreaterThanOrEqual(mediaBox!.y - 1);
  expect(videoBox!.x + videoBox!.width).toBeLessThanOrEqual(mediaBox!.x + mediaBox!.width + 1);
  expect(videoBox!.y + videoBox!.height).toBeLessThanOrEqual(mediaBox!.y + mediaBox!.height + 1);
  await page.keyboard.press("Escape");
  await expect(videoPreview).toHaveCount(0);
});

test("optional minimap and shortcut help restore legacy navigation affordances", async ({
  page,
}) => {
  await cleanProject(page);
  await openCanvas(page);

  await expect(page.locator(".wc-mini-map")).toHaveCount(0);
  await page.getByLabel("显示小地图").click();
  await expect(page.getByLabel("画布小地图")).toBeVisible();
  await expect(page.getByLabel("隐藏小地图")).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await expect(page.getByLabel("画布小地图")).toBeVisible();
  await page.getByLabel("隐藏小地图").click();
  await expect(page.locator(".wc-mini-map")).toHaveCount(0);

  await page.getByLabel("画布快捷键").click();
  const dialog = page.getByRole("dialog", { name: "画布快捷键" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("复制选中内容");
  await expect(page.getByLabel("关闭快捷键说明")).toBeFocused();
  await page.getByLabel("关闭快捷键说明").click();
  await expect(dialog).toBeHidden();

  await page.keyboard.press("Shift+/");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  const projectName = page.getByLabel("项目名称");
  await projectName.focus();
  await page.keyboard.press("Shift+/");
  await expect(dialog).toBeHidden();
});

test("node hover toolbar stays stable and opens functional overlays", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  const toolbar = page.locator(".wc-node-action-toolbar");
  const configNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="config"])',
  );

  await configNode.hover();
  await expect(toolbar).toBeVisible();
  await expect(page.locator(".wc-node-caption, .wc-node-textarea")).toHaveCount(0);
  await toolbar.hover();
  await page.waitForTimeout(220);
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveCount(1);

  await toolbar.getByLabel("节点信息").click();
  const infoDialog = page.getByRole("dialog", { name: "节点信息" });
  await expect(infoDialog).toBeVisible();
  await expect(infoDialog).toContainText("配置节点");
  await infoDialog.getByLabel("收起").click();
  await expect(infoDialog).toBeHidden();

  const textNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  await textNode.hover();
  await toolbar.getByLabel("全屏编辑").click();
  const editDialog = page.getByRole("dialog", { name: "编辑文本节点" });
  const editor = editDialog.getByLabel("节点内容");
  await expect(editor).toBeFocused();
  await editor.fill("全屏编辑后的分镜文本");
  await editDialog.getByLabel("收起").click();
  await expect(textNode.locator(".wc-node-text-preview")).toHaveText("全屏编辑后的分镜文本");
});

test("space pan releases cleanly and pointer movement does not stay attached", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  const pane = page.locator(".react-flow__pane");
  const viewport = page.locator(".react-flow__viewport");
  const textPreview = page.locator(".wc-node-text-preview").first();
  const edges = page.locator(".react-flow__edge");
  const box = await pane.boundingBox();
  expect(box).not.toBeNull();

  await page.keyboard.down("Space");
  await page.mouse.move(box!.x + 980, box!.y + 570);
  await page.mouse.down();
  await page.mouse.move(box!.x + 1080, box!.y + 630, { steps: 6 });
  await expect(textPreview).toBeVisible();
  await expect(edges).toHaveCount(2);
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect(page.locator(".wc-workspace")).not.toHaveClass(/is-space-pan/);

  const releasedTransform = await viewport.getAttribute("style");
  await page.mouse.move(box!.x + 760, box!.y + 420, { steps: 8 });
  await page.waitForTimeout(120);
  expect(await viewport.getAttribute("style")).toBe(releasedTransform);
});

test("blank canvas left drag stays still until Space enables panning", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  const pane = page.locator(".react-flow__pane");
  const viewport = page.locator(".react-flow__viewport");
  const workspace = page.locator(".wc-workspace");
  const box = await pane.boundingBox();
  expect(box).not.toBeNull();

  const start = { x: box!.x + box!.width - 210, y: box!.y + box!.height - 190 };
  const before = await viewport.getAttribute("style");
  await page.mouse.move(start.x, start.y);
  // 空格未按下时不得进入平移态。自绘光标的 is-pan 类随组件一起删了，
  // 改看工作区的 is-space-pan 与面板的 dragging 态。
  await expect(workspace).not.toHaveClass(/is-space-pan/);
  await page.mouse.down();
  await page.mouse.move(start.x + 120, start.y + 64, { steps: 8 });
  await page.mouse.up();
  expect(await viewport.getAttribute("style")).toBe(before);

  await page.keyboard.down("Space");
  await expect(workspace).toHaveClass(/is-space-pan/);
  await page.mouse.down();
  await page.mouse.move(start.x + 220, start.y + 124, { steps: 8 });
  await expect(pane).toHaveClass(/dragging/);
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(before);
  await expect(workspace).not.toHaveClass(/is-space-pan/);
  await expect(pane).not.toHaveClass(/dragging/);
});

test("blank left drag draws a selection box without moving the canvas", async ({
  page,
}, testInfo) => {
  await cleanProject(page);
  await openCanvas(page);
  const node = page.locator(".react-flow__node-weftcanvas").first();
  const viewport = page.locator(".react-flow__viewport");
  const nodeBox = await node.boundingBox();
  expect(nodeBox).not.toBeNull();

  const before = await viewport.getAttribute("style");
  const start = { x: nodeBox!.x - 28, y: nodeBox!.y - 28 };
  const end = { x: nodeBox!.x + nodeBox!.width + 28, y: nodeBox!.y + nodeBox!.height + 28 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  const marquee = page.locator(".react-flow__selection");
  await expect(marquee).toBeVisible();
  const marqueeMaterial = await marquee.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderRadius: style.borderRadius,
      borderStyle: style.borderStyle,
      borderColor: style.borderColor,
      backgroundColor: style.backgroundColor,
    };
  });
  expect(marqueeMaterial).toMatchObject({ borderRadius: "8px", borderStyle: "solid" });
  expect(marqueeMaterial.borderColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(marqueeMaterial.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({ path: testInfo.outputPath("selection-marquee.png"), fullPage: true });
  await page.mouse.up();

  await expect(node).toHaveClass(/selected/);
  const selectedFeedback = await node.evaluate((element) => {
    const style = getComputedStyle(element, "::after");
    return {
      borderStyle: style.borderStyle,
      borderWidth: style.borderWidth,
      borderColor: style.borderColor,
    };
  });
  expect(selectedFeedback.borderStyle).toBe("solid");
  expect(Number.parseFloat(selectedFeedback.borderWidth)).toBeGreaterThanOrEqual(1);
  expect(selectedFeedback.borderColor).not.toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({
    path: testInfo.outputPath("selected-node-feedback.png"),
    fullPage: true,
  });
  expect(await viewport.getAttribute("style")).toBe(before);
});

test("marquee multi-selection does not open every node prompt composer", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  const nodes = page.locator(".react-flow__node-weftcanvas");
  const boxes = await nodes.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    }),
  );
  const start = {
    x: Math.max(2, Math.min(...boxes.map((box) => box.left)) - 22),
    y: Math.max(2, Math.min(...boxes.map((box) => box.top)) - 22),
  };
  const end = {
    x: Math.max(...boxes.map((box) => box.right)) + 22,
    y: Math.max(...boxes.map((box) => box.bottom)) + 22,
  };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await expect(page.locator(".react-flow__selection")).toBeVisible();
  await expect(page.locator(".wc-node-prompt-composer")).toHaveCount(0);
  await page.mouse.up();

  await expect(page.locator(".react-flow__node-weftcanvas.selected")).toHaveCount(boxes.length);
  await expect(page.locator(".wc-node-prompt-composer")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await nodes.first().locator(".wc-node-drag-strip").click();
  await expect(page.locator(".react-flow__node-weftcanvas.selected")).toHaveCount(1);
  await expect(page.locator(".wc-node-prompt-composer")).toHaveCount(1);
});

test("multi-selection exposes complete group, duplicate, delete, and clear actions", async ({
  page,
}) => {
  await cleanProject(page);
  await openCanvas(page);
  const nodes = page.locator(".react-flow__node-weftcanvas");
  const boxes = await nodes.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    }),
  );
  const start = {
    x: Math.min(...boxes.map((box) => box.left)) - 24,
    y: Math.min(...boxes.map((box) => box.top)) - 24,
  };
  const end = {
    x: Math.max(...boxes.map((box) => box.right)) + 24,
    y: Math.max(...boxes.map((box) => box.bottom)) + 24,
  };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();

  const selectionToolbar = page.getByRole("toolbar", { name: "已选择 3 个节点" });
  await expect(selectionToolbar).toBeVisible();
  const selectionRect = page.locator(".react-flow__nodesselection-rect");
  await expect(selectionRect).toHaveCSS("border-style", "solid");
  await expect(selectionRect).not.toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
  await expect(selectionRect).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await selectionToolbar.getByLabel("组合选中节点").click();
  await expect(page.locator(".wc-group-frame")).toHaveCount(1);
  await expect(selectionToolbar.getByLabel("解散选中组合")).toBeVisible();

  await selectionToolbar.getByLabel("创建选中节点副本").click();
  await expect(nodes).toHaveCount(6);
  await expect(page.locator(".wc-group-frame")).toHaveCount(2);
  await selectionToolbar.getByLabel("删除选中节点").click();
  await expect(nodes).toHaveCount(3);
  await expect(page.locator(".wc-group-frame")).toHaveCount(1);

  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("清空画布").click();
  const clearDialog = page.getByRole("dialog", { name: "清空画布" });
  await expect(clearDialog).toContainText("3 个节点");
  await clearDialog.getByRole("button", { name: "清空画布" }).click();
  await expect(nodes).toHaveCount(0);
  await page.keyboard.press("Control+Z");
  await expect(nodes).toHaveCount(3);
});

test("wheel pans vertically and Control plus wheel zooms", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);

  const pane = page.locator(".react-flow__pane");
  const viewport = page.locator(".react-flow__viewport");
  const box = await pane.boundingBox();
  expect(box).not.toBeNull();

  const readViewport = () =>
    viewport.evaluate((element) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
    });

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const initial = await readViewport();
  await page.mouse.wheel(0, 240);
  await expect.poll(readViewport).not.toEqual(initial);
  const panned = await readViewport();
  expect(panned.zoom).toBeCloseTo(initial.zoom, 5);
  expect(panned.y).toBeLessThan(initial.y);

  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await readViewport()).zoom).toBeGreaterThan(panned.zoom);

  const afterControlZoom = await readViewport();
  await page.keyboard.down("Meta");
  await page.mouse.wheel(0, -180);
  await page.keyboard.up("Meta");
  await expect.poll(async () => (await readViewport()).zoom).toBeGreaterThan(afterControlZoom.zoom);
});

test("zoom controls allow a ten percent overview without crossing the lower bound", async ({
  page,
}) => {
  await cleanProject(page);
  await openCanvas(page);

  const slider = page.locator('.wc-zoom-control input[type="range"]');
  const zoomOut = page.getByRole("button", { name: "缩小", exact: true });
  const viewport = page.locator(".react-flow__viewport");
  const readZoom = () =>
    viewport.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);

  await expect(slider).toHaveAttribute("min", "10");
  await slider.fill("25");
  await expect.poll(readZoom).toBeCloseTo(0.25, 2);

  for (let step = 0; step < 8; step += 1) {
    await zoomOut.click();
    await page.waitForTimeout(170);
  }
  await expect.poll(readZoom).toBeCloseTo(0.1, 2);
  await expect(slider).toHaveValue("10");

  await zoomOut.click();
  await page.waitForTimeout(170);
  expect(await readZoom()).toBeCloseTo(0.1, 2);
});

test("nodes created and media dropped at a ten percent overview keep stable intrinsic dimensions", async ({
  page,
}, testInfo) => {
  await cleanProject(page);
  await openCanvas(page);

  const slider = page.locator('.wc-zoom-control input[type="range"]');
  const nodes = page.locator(".react-flow__node-weftcanvas");
  const viewport = page.locator(".react-flow__viewport");
  const readZoom = () =>
    viewport.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
  await slider.fill("10");
  await expect(slider).toHaveValue("10");

  const beforeCreate = await nodes.count();
  await page
    .getByRole("navigation", { name: "创建工具" })
    .locator(".wc-create-rail-plus-wrapper")
    .hover();
  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("menuitem", { name: "添加图片节点" })
    .click();
  await expect(nodes).toHaveCount(beforeCreate + 1);
  const overviewBox = await nodes.last().boundingBox();
  expect(overviewBox).not.toBeNull();
  expect(overviewBox!.width).toBeGreaterThanOrEqual(30);
  expect(overviewBox!.width).toBeLessThan(60);

  const shell = page.locator(".wc-flow-shell");
  const shellBox = await shell.boundingBox();
  expect(shellBox).not.toBeNull();
  const dropPoint = {
    x: shellBox!.x + shellBox!.width * 0.72,
    y: shellBox!.y + shellBox!.height * 0.62,
  };
  await shell.evaluate((element, point) => {
    const binary = atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    );
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "overview-upload.png", { type: "image/png" }));
    element.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        dataTransfer: transfer,
      }),
    );
  }, dropPoint);

  await expect(nodes).toHaveCount(beforeCreate + 2);
  const uploaded = nodes.last();
  await expect(uploaded.locator("img")).toBeVisible();
  const uploadedOverviewBox = await uploaded.boundingBox();
  expect(uploadedOverviewBox).not.toBeNull();
  expect(uploadedOverviewBox!.width).toBeLessThan(60);

  // Zoom back to full against the created node's center. The starter-era
  // viewport places created nodes far from the flow origin and the zoom slider
  // keeps the pan fixed, so a slider fill(100) would leave them outside the
  // viewport, where onlyRenderVisibleElements unmounts them. Control+wheel
  // anchors the zoom at the pointer; the fresh node is unselected, so the app
  // zooms the canvas instead of resizing the node. After zooming, only the
  // nodes inside the viewport stay mounted, so locate by data-id rather than
  // index.
  const created = nodes.nth(beforeCreate);
  const createdId = await created.getAttribute("data-id");
  expect(createdId).not.toBeNull();
  const createdById = page.locator(`.react-flow__node-weftcanvas[data-id="${createdId}"]`);
  const createdOverviewBox = await created.boundingBox();
  expect(createdOverviewBox).not.toBeNull();
  await page.mouse.move(
    createdOverviewBox!.x + createdOverviewBox!.width / 2,
    createdOverviewBox!.y + createdOverviewBox!.height / 2,
  );
  await page.keyboard.down("Control");
  while ((await readZoom()) < 0.95) {
    await page.mouse.wheel(0, -240);
  }
  await page.keyboard.up("Control");

  await expect
    .poll(async () => {
      const box = await createdById.boundingBox();
      return box ? Math.round(box.width / (await readZoom())) : -1;
    })
    .toBeGreaterThanOrEqual(330);
  const createdAtFullZoom = await createdById.boundingBox();
  expect(createdAtFullZoom).not.toBeNull();
  const fullZoom = await readZoom();
  expect(Math.round(createdAtFullZoom!.width / fullZoom)).toBeGreaterThanOrEqual(330);
  expect(Math.round(createdAtFullZoom!.width / fullZoom)).toBeLessThanOrEqual(400);
  expect(createdAtFullZoom!.width).toBeLessThan(1440 * 0.5 * fullZoom);

  await page.screenshot({
    path: testInfo.outputPath("stable-node-size-at-full-zoom.png"),
    fullPage: true,
  });
});

test("Control plus wheel resizes the selected node without zooming the canvas", async ({
  page,
}) => {
  await cleanProject(page);
  await openCanvas(page);

  const viewport = page.locator(".react-flow__viewport");
  const textNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  await textNode.locator(".wc-node-drag-strip").click();

  const beforeNode = await textNode.boundingBox();
  const beforeZoom = await viewport.evaluate(
    (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
  );
  expect(beforeNode).not.toBeNull();

  await page.mouse.move(
    beforeNode!.x + beforeNode!.width / 2,
    beforeNode!.y + beforeNode!.height / 2,
  );
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -220);
  await page.keyboard.up("Control");

  await expect
    .poll(async () => (await textNode.boundingBox())?.width ?? 0)
    .toBeGreaterThan(beforeNode!.width + 20);
  const afterZoom = await viewport.evaluate(
    (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
  );
  expect(afterZoom).toBeCloseTo(beforeZoom, 5);

  await page.waitForTimeout(240);
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await textNode.boundingBox())?.width ?? 0)
    .toBeCloseTo(beforeNode!.width, 0);
});

test("Control plus wheel over a node prompt zooms the canvas instead of the browser or node", async ({
  page,
}) => {
  await cleanProject(page);
  await openCanvas(page);

  const viewport = page.locator(".react-flow__viewport");
  const textNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  await textNode.locator(".wc-node-drag-strip").click();
  const prompt = page.getByLabel("文本节点提示词");
  await expect(prompt).toBeVisible();

  const beforeNode = await textNode.boundingBox();
  const beforeViewport = await viewport.evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
  });
  const beforePageScale = await page.evaluate(() => ({
    ratio: document.documentElement.getBoundingClientRect().width / window.innerWidth,
    visual: window.visualViewport?.scale ?? 1,
  }));
  const promptBox = await prompt.boundingBox();
  expect(beforeNode).not.toBeNull();
  expect(promptBox).not.toBeNull();

  await page.evaluate(() => {
    (window as Window & { __kcWheelPrevented?: boolean }).__kcWheelPrevented = false;
    window.addEventListener(
      "wheel",
      (event) => {
        window.setTimeout(() => {
          (window as Window & { __kcWheelPrevented?: boolean }).__kcWheelPrevented =
            event.defaultPrevented;
        });
      },
      { capture: true, once: true },
    );
  });

  await page.mouse.move(promptBox!.x + promptBox!.width / 2, promptBox!.y + promptBox!.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -220);
  await page.keyboard.up("Control");

  await expect
    .poll(async () =>
      viewport.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a),
    )
    .toBeGreaterThan(beforeViewport.zoom);
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { __kcWheelPrevented?: boolean }).__kcWheelPrevented),
    )
    .toBe(true);
  const afterPromptZoom = await viewport.evaluate(
    (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
  );
  const editorControl = page.locator(".wc-node-reference-trigger");
  const editorControlBox = await editorControl.boundingBox();
  expect(editorControlBox).not.toBeNull();
  await page.mouse.move(
    editorControlBox!.x + editorControlBox!.width / 2,
    editorControlBox!.y + editorControlBox!.height / 2,
  );
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -140);
  await page.keyboard.up("Control");
  await expect
    .poll(async () =>
      viewport.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a),
    )
    .toBeGreaterThan(afterPromptZoom);
  const afterNode = await textNode.boundingBox();
  const afterPageScale = await page.evaluate(() => ({
    ratio: document.documentElement.getBoundingClientRect().width / window.innerWidth,
    visual: window.visualViewport?.scale ?? 1,
  }));
  expect(afterNode).not.toBeNull();
  expect(afterNode!.width / beforeNode!.width).toBeCloseTo(
    (await viewport.evaluate(
      (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
    )) / beforeViewport.zoom,
    1,
  );
  expect(afterPageScale).toEqual(beforePageScale);
});

test("pointer feedback pulses on interactive hover and press while the native cursor stays visible", async ({
  page,
}, testInfo) => {
  await cleanProject(page);
  await openCanvas(page);
  const pulse = page.getByTestId("pointer-pulse");
  await expect(pulse).toBeAttached();
  // 自绘光标已下线：原生光标必须仍然可见，<html> 上不再挂 has-wc-cursor。
  await expect(page.locator("html")).not.toHaveClass(/has-wc-cursor/);
  expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).not.toBe("none");
  // 反馈层不能参与命中，否则会挡住画布与按钮。
  expect(await pulse.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");

  // 进入可交互元素时放一次扩散环。它是一次性的（320ms 后自动摘掉类），
  // 所以断言要紧跟动作，用轮询超时兜住时序。
  await page.getByLabel("切换主题").hover();
  await expect(pulse).toHaveClass(/is-enter/, { timeout: 1_000 });
  const textNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  await textNode.locator(".wc-node-text-preview").hover();
  await expect(pulse).toHaveClass(/is-enter/, { timeout: 1_000 });

  await page.mouse.down();
  await expect(pulse).toHaveClass(/is-press/, { timeout: 1_000 });
  await page.mouse.up();

  // 动画结束后必须自行消失：不留常驻图层，也不逐帧跟随。
  await page.waitForTimeout(600);
  await expect(pulse).not.toHaveClass(/is-enter|is-press/);

  await page.getByLabel("切换主题").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByLabel("项目菜单").hover();
  await expect(pulse).toHaveClass(/is-enter/, { timeout: 1_000 });
  await page.screenshot({ path: testInfo.outputPath("pointer-pulse-light.png") });
});

test("node drag, quick add, clipboard, and text deletion stay predictable", async ({ page }) => {
  const flowWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning" && message.text().includes("[React Flow]"))
      flowWarnings.push(message.text());
  });
  await cleanProject(page);
  await openCanvas(page);
  const nodes = page.locator(".react-flow__node-weftcanvas");
  const edges = page.locator(".react-flow__edge");
  const textNode = nodes.filter({ has: page.locator('.wc-node-wrap[data-node-kind="text"]') });

  await textNode.hover();
  const nodeToolbar = page.locator(".wc-node-action-toolbar");
  await nodeToolbar.getByLabel("全屏编辑").click();
  const editDialog = page.getByRole("dialog", { name: "编辑文本节点" });
  const body = editDialog.getByLabel("节点内容");
  await expect(body).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await expect(nodes).toHaveCount(3);
  await editDialog.getByLabel("收起").click();

  const dragTarget = textNode.locator(".wc-node-text-preview");
  const before = await textNode.boundingBox();
  const target = await dragTarget.boundingBox();
  expect(before).not.toBeNull();
  expect(target).not.toBeNull();
  await page.mouse.move(target!.x + 34, target!.y + target!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + 88, target!.y + target!.height / 2 + 24, { steps: 5 });
  await page.waitForTimeout(180);
  await page.mouse.move(target!.x + 174, target!.y + 72, { steps: 7 });
  await page.mouse.up();
  const after = await textNode.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.x - before!.x)).toBeGreaterThan(50);

  await textNode.locator(".wc-node-drag-strip").click();
  await page.keyboard.press("Control+C");
  await page.keyboard.press("Control+V");
  await expect(nodes).toHaveCount(4);
  await page.keyboard.press("Control+Z");
  await expect(nodes).toHaveCount(3);

  await textNode.locator(".wc-node-port-zone--right .wc-node-port-core").click();
  await textNode.getByLabel("添加图片节点").click();
  await expect(nodes).toHaveCount(4);
  await expect(edges).toHaveCount(3);
  expect(flowWarnings).toEqual([]);
});

test("system clipboard text and images create centered canvas nodes", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  const nodes = page.locator(".react-flow__node-weftcanvas");

  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "从系统剪贴板进入的分镜提示");
    window.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
  });
  await expect(nodes).toHaveCount(4);
  const pastedText = page
    .locator('.wc-node-wrap[data-node-kind="text"]')
    .filter({ hasText: "从系统剪贴板进入的分镜提示" });
  await expect(pastedText).toHaveCount(1);
  const nativeCopyTypes = await page.locator(".wc-project-heading > span").evaluate((element) => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    const transfer = new DataTransfer();
    window.dispatchEvent(
      new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
    selection.removeAllRanges();
    return Array.from(transfer.types);
  });
  expect(nativeCopyTypes).not.toContain("application/x-weftcanvas-selection");
  await page.keyboard.press("Control+Z");
  await expect(nodes).toHaveCount(3);

  await page.evaluate(() => {
    const binary = atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    );
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "clipboard-frame.png", { type: "image/png" }));
    window.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
  });
  await expect(nodes).toHaveCount(4);
  await expect(
    page.locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"]) img'),
  ).toBeVisible();
});

test("multi-file drop is laid out as one undoable insertion", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  const shell = page.locator(".wc-flow-shell");
  const shellBox = await shell.boundingBox();
  expect(shellBox).not.toBeNull();
  const dropPoint = {
    x: shellBox!.x + shellBox!.width * 0.67,
    y: shellBox!.y + shellBox!.height * 0.6,
  };

  await shell.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["preview"], "preview.txt", { type: "text/plain" }));
    element.dispatchEvent(
      new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });
  await expect(shell).toHaveClass(/is-file-drop-active/);

  await shell.evaluate((element, point) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["镜头一"], "shot-one.txt", { type: "text/plain" }));
    transfer.items.add(new File(["镜头二"], "shot-two.md", { type: "text/markdown" }));
    transfer.items.add(new File(["invalid"], "archive.zip", { type: "application/zip" }));
    element.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        dataTransfer: transfer,
      }),
    );
  }, dropPoint);
  await expect(shell).not.toHaveClass(/is-file-drop-active/);

  const inserted = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-text-preview:text-is("镜头一")), .react-flow__node-weftcanvas:has(.wc-node-text-preview:text-is("镜头二"))',
  );
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(5);
  await expect(inserted).toHaveCount(2);
  await expect(page.locator(".react-flow__node-weftcanvas.selected")).toHaveCount(2);
  await expect(page.locator(".wc-node-prompt-composer")).toHaveCount(0);
  const insertedBoxes = await inserted.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }),
  );
  expect(insertedBoxes[0]!.right).toBeLessThan(insertedBoxes[1]!.left);
  await expect(page.locator(".wc-toast--error")).toContainText("1 个文件无法加入画布");

  await page.keyboard.press("Control+Z");
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(3);
});

test("context menu preserves multi-selection and stays inside the viewport", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  const nodes = page.locator(".react-flow__node-weftcanvas");
  const first = nodes.nth(0);
  const second = nodes.nth(1);
  await first.locator(".wc-node-drag-strip").click();
  await page.keyboard.down("Control");
  await second.locator(".wc-node-drag-strip").click();
  await page.keyboard.up("Control");
  await expect(page.locator(".react-flow__node-weftcanvas.selected")).toHaveCount(2);

  await second.locator(".wc-node-drag-strip").click({ button: "right" });
  const nodeMenu = page.getByRole("menu", { name: "节点操作" });
  await expect(nodeMenu).toBeVisible();
  await expect(page.locator(".react-flow__node-weftcanvas.selected")).toHaveCount(2);
  await page.keyboard.press("Backspace");
  await expect(nodes).toHaveCount(3);
  await nodeMenu.getByRole("menuitem", { name: "复制选中节点" }).click();

  const pane = page.locator(".react-flow__pane");
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();
  await page.mouse.click(paneBox!.x + paneBox!.width - 4, paneBox!.y + paneBox!.height - 4, {
    button: "right",
  });
  const paneMenu = page.getByRole("menu", { name: "画布操作" });
  await expect(paneMenu).toBeVisible();
  const menuBox = await paneMenu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width - 11);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height - 11);
  await paneMenu.getByRole("menuitem", { name: "粘贴到此处" }).click();
  await expect(nodes).toHaveCount(5);
  await expect(page.locator(".react-flow__node-weftcanvas.selected")).toHaveCount(2);
  const pastedBoxes = await page
    .locator(".react-flow__node-weftcanvas.selected")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      }),
    );
  expect(Math.min(...pastedBoxes.map((box) => box.left))).toBeGreaterThanOrEqual(20);
  expect(Math.max(...pastedBoxes.map((box) => box.right))).toBeLessThanOrEqual(
    page.viewportSize()!.width - 20,
  );
  expect(Math.max(...pastedBoxes.map((box) => box.bottom))).toBeLessThanOrEqual(
    page.viewportSize()!.height - 20,
  );
});

test("edge context menu deletes only the selected connection and remains undoable", async ({
  page,
}) => {
  await cleanProject(page);
  await openCanvas(page);
  const edges = page.locator(".react-flow__edge");
  await expect(edges).toHaveCount(2);
  await edges
    .first()
    .locator(".react-flow__edge-interaction")
    .click({ button: "right", force: true });
  const menu = page.getByRole("menu", { name: "连线操作" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "删除连线" }).click();
  await expect(edges).toHaveCount(1);
  await page.keyboard.press("Control+Z");
  await expect(edges).toHaveCount(2);
});

test("image media persists in IndexedDB and renders", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  const beforeUpload = await imageNode.boundingBox();
  const input = imageNode.locator('input[type="file"]');
  await input.setInputFiles({
    name: "frame.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(imageNode.locator("img")).toBeVisible();
  const afterUpload = await imageNode.boundingBox();
  expect(beforeUpload).not.toBeNull();
  expect(afterUpload).not.toBeNull();
  expect(afterUpload!.height - beforeUpload!.height).toBeGreaterThan(90);
  expect(Math.abs(afterUpload!.width - afterUpload!.height)).toBeLessThan(3);
  await expect(imageNode.locator(".wc-node-media-frame")).toHaveClass(/is-measured/);
  const mediaBounds = await imageNode.evaluate((node) => {
    const surface = node.querySelector<HTMLElement>(".wc-node-surface")!.getBoundingClientRect();
    const image = node.querySelector<HTMLImageElement>("img")!.getBoundingClientRect();
    return {
      widthDelta: Math.abs(surface.width - image.width),
      heightDelta: Math.abs(surface.height - image.height),
    };
  });
  expect(mediaBounds.widthDelta).toBeLessThan(3);
  expect(mediaBounds.heightDelta).toBeLessThan(3);

  const beforeDrag = await imageNode.boundingBox();
  const imageBounds = await imageNode.locator("img").boundingBox();
  expect(beforeDrag).not.toBeNull();
  expect(imageBounds).not.toBeNull();
  await page.mouse.move(
    imageBounds!.x + imageBounds!.width * 0.42,
    imageBounds!.y + imageBounds!.height * 0.42,
  );
  await page.mouse.down();
  await page.mouse.move(
    imageBounds!.x + imageBounds!.width * 0.42 + 96,
    imageBounds!.y + imageBounds!.height * 0.42 + 34,
    { steps: 9 },
  );
  await page.mouse.up();
  const afterDrag = await imageNode.boundingBox();
  expect(afterDrag).not.toBeNull();
  expect(Math.abs(afterDrag!.x - beforeDrag!.x)).toBeGreaterThan(55);

  await page.waitForTimeout(240);
  await page.reload();
  await expect(
    page.locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"]) img'),
  ).toBeVisible();
});

test("node prompt composer shows connected media and renders references as previewable thumbnails", async ({
  page,
}, testInfo) => {
  await cleanProject(page);
  await openCanvas(page);

  const imageNode = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])')
    .first();
  await imageNode.locator('input[type="file"]').setInputFiles({
    name: "reference-frame.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(imageNode.locator("img")).toBeVisible();

  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("button", { name: "添加视频节点" })
    .click();
  const videoNode = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])')
    .last();
  await imageNode.hover();
  const imageSource = await imageNode
    .locator(".wc-node-port-zone--right .wc-node-port-core")
    .boundingBox();
  const videoTarget = await videoNode.boundingBox();
  expect(imageSource).not.toBeNull();
  expect(videoTarget).not.toBeNull();
  await page.mouse.move(
    imageSource!.x + imageSource!.width / 2,
    imageSource!.y + imageSource!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(videoTarget!.x + 2, videoTarget!.y + videoTarget!.height / 2, {
    steps: 14,
  });
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);

  await imageNode.locator(".wc-node-drag-strip").click();
  for (let index = 0; index < 4; index += 1) await page.keyboard.press("Control+D");
  await expect(
    page.locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])'),
  ).toHaveCount(5);
  await page.keyboard.press("Escape");
  await videoNode.locator(".wc-node-drag-strip").click();
  const prompt = page.getByLabel("视频节点提示词");
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveAttribute("contenteditable", "true");
  const promptComposer = page.locator(".wc-node-prompt-composer");
  const composerBox = await promptComposer.boundingBox();
  const promptBox = await prompt.boundingBox();
  const selectedNodeBox = await videoNode.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(promptBox).not.toBeNull();
  expect(selectedNodeBox).not.toBeNull();
  expect(composerBox!.y).toBeGreaterThanOrEqual(selectedNodeBox!.y + selectedNodeBox!.height + 7);
  expect(composerBox!.width).toBeGreaterThanOrEqual(560);
  expect(composerBox!.width).toBeLessThanOrEqual(900);
  expect(composerBox!.height).toBeGreaterThanOrEqual(190);
  expect(composerBox!.height).toBeLessThanOrEqual(340);
  expect(promptBox!.height).toBeGreaterThanOrEqual(120);
  const inlineSettings = page.getByLabel("视频节点创作设置");
  await inlineSettings.hover();
  await expect(inlineSettings).toBeVisible();
  const inlineModel = inlineSettings.getByLabel("模型");
  const inlineGenerate = inlineSettings.getByRole("button", { name: "生成", exact: true });
  await expect(inlineModel).toBeVisible();
  await expect(inlineGenerate).toBeVisible();
  const modelBox = await inlineModel.boundingBox();
  const generateBox = await inlineGenerate.boundingBox();
  expect(modelBox).not.toBeNull();
  expect(generateBox).not.toBeNull();
  expect(
    Math.abs(modelBox!.y + modelBox!.height / 2 - (generateBox!.y + generateBox!.height / 2)),
  ).toBeLessThan(8);

  const connectedReferences = page.getByLabel("已连接素材");
  await expect(connectedReferences).toBeVisible();
  const connectedReference = connectedReferences.locator(".wc-node-reference-chip").first();
  const connectedReferenceChoice = connectedReference.locator(".wc-node-reference-choice");
  await expect(connectedReferenceChoice).toHaveAttribute("aria-pressed", "false");
  await expect(connectedReference.locator("img")).toBeVisible();
  await connectedReference
    .locator(".wc-node-reference-thumbnail")
    .hover({ position: { x: 10, y: 30 } });
  const hoverPreview = page.locator("[data-reference-preview]");
  await expect(hoverPreview).toBeVisible();
  await expect(hoverPreview.locator("img")).toBeVisible();
  const hoverPreviewBox = await hoverPreview.boundingBox();
  const viewport = page.viewportSize()!;
  expect(hoverPreviewBox).not.toBeNull();
  expect(hoverPreviewBox!.x).toBeGreaterThanOrEqual(0);
  expect(hoverPreviewBox!.y).toBeGreaterThanOrEqual(0);
  expect(hoverPreviewBox!.x + hoverPreviewBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(hoverPreviewBox!.y + hoverPreviewBox!.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({ path: testInfo.outputPath("connected-reference-preview.png") });

  await prompt.fill("镜头缓慢推进 ");
  await prompt.pressSequentially("@");
  const picker = page.getByRole("listbox", { name: "选择参考素材" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option")).toHaveCount(1);
  const reference = picker.getByRole("option").first();
  await expect(reference).toBeVisible();
  await reference.click();
  await expect(picker).toBeHidden();
  await expect(connectedReferenceChoice).toHaveAttribute("aria-pressed", "true");
  const token = prompt.locator("[data-reference-token]");
  await expect(token).toHaveCount(1);
  await expect(token).toHaveAttribute("data-reference-token", "@图片1");
  await expect(token.locator("img")).toBeVisible();
  await token.locator(".wc-node-reference-thumbnail").hover();
  await expect(page.locator("[data-reference-preview]").locator("img")).toBeVisible();
  const inlinePreviewBox = await page.locator("[data-reference-preview]").boundingBox();
  expect(inlinePreviewBox).not.toBeNull();
  expect(inlinePreviewBox!.x + inlinePreviewBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(inlinePreviewBox!.y + inlinePreviewBox!.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({ path: testInfo.outputPath("inline-reference-token-preview.png") });

  await page.setViewportSize({ width: 430, height: 800 });
  await expect
    .poll(async () => {
      const box = await promptComposer.boundingBox();
      return box ? box.x + box.width : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(419);
  const compactComposerBox = await promptComposer.boundingBox();
  expect(compactComposerBox).not.toBeNull();
  expect(compactComposerBox!.x).toBeGreaterThanOrEqual(11);
  expect(compactComposerBox!.x + compactComposerBox!.width).toBeLessThanOrEqual(419);
  expect(await prompt.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("inline-reference-token-compact.png") });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.keyboard.press("Backspace");
  await expect(token).toHaveCount(0);
  await expect(prompt).toHaveText("镜头缓慢推进");
  await expect(connectedReferenceChoice).toHaveAttribute("aria-pressed", "false");

  await prompt.fill("联系 test@example.com");
  await expect(picker).toBeHidden();
  await prompt.fill("镜头缓慢推进，参考");
  await prompt.pressSequentially("@");
  await expect(picker).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(prompt.locator("[data-reference-token]")).toHaveCount(1);
  await expect(prompt).toContainText("镜头缓慢推进，参考");

  await prompt.getByRole("button", { name: /移除参考素材/ }).click();
  await expect(prompt.locator("[data-reference-token]")).toHaveCount(0);

  await page.getByLabel("引用画布素材").click();
  await expect(prompt).toHaveText("镜头缓慢推进，参考 @");
  await page.keyboard.press("Escape");
  await expect(prompt).toHaveText("镜头缓慢推进，参考");

  await prompt.fill("镜头缓慢推进，人物在雨中回头");
  await expect(inlineSettings).toBeVisible();

  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await page.reload();
  const restoredVideo = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])')
    .last();
  await restoredVideo.locator(".wc-node-drag-strip").click();
  await expect(page.getByLabel("视频节点提示词")).toHaveText("镜头缓慢推进，人物在雨中回头");
  await expect(page.getByLabel("已连接素材")).toBeVisible();
  await expect(page.getByLabel("视频节点提示词").locator("[data-reference-token]")).toHaveCount(0);
  const savedGeneration = await page.evaluate(() => {
    const projectId = localStorage.getItem("weftcanvas:active-project:v1");
    const raw = projectId
      ? localStorage.getItem(`weftcanvas:project-data:v1:${encodeURIComponent(projectId)}`)
      : null;
    const project = raw
      ? (JSON.parse(raw) as {
          nodes: Array<{
            data: {
              kind: string;
              generation: { referenceMode: string; referenceNodeIds: string[] };
            };
          }>;
        })
      : null;
    return project?.nodes.find((node) => node.data.kind === "video")?.data.generation ?? null;
  });
  expect(savedGeneration).toMatchObject({ referenceMode: "explicit", referenceNodeIds: [] });
});

test("node prompt editor keeps the clicked insertion point while typing", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);

  const imageNode = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])')
    .first();
  await imageNode.locator('input[type="file"]').setInputFiles({
    name: "caret-reference.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("button", { name: "添加视频节点" })
    .click();
  const videoNode = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])')
    .first();
  await imageNode.hover();
  const imageSource = await imageNode
    .locator(".wc-node-port-zone--right .wc-node-port-core")
    .boundingBox();
  const videoTarget = await videoNode.boundingBox();
  expect(imageSource).not.toBeNull();
  expect(videoTarget).not.toBeNull();
  await page.mouse.move(
    imageSource!.x + imageSource!.width / 2,
    imageSource!.y + imageSource!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(videoTarget!.x + 2, videoTarget!.y + videoTarget!.height / 2, {
    steps: 14,
  });
  await page.mouse.up();
  await videoNode.locator(".wc-node-drag-strip").click();
  const prompt = page.getByLabel("视频节点提示词");
  await prompt.fill("甲乙丙丁");
  await prompt.evaluate((editor) => {
    (editor as HTMLElement & { __stablePromptEditor?: boolean }).__stablePromptEditor = true;
  });

  const insertionPoint = await prompt.evaluate((editor) => {
    const text = editor.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("Expected a plain text prompt");
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    return { x: rect.left - editorRect.left, y: rect.top - editorRect.top + rect.height / 2 };
  });
  await prompt.click({ position: insertionPoint });
  await page.keyboard.insertText("中");

  await expect(prompt).toHaveText("甲乙中丙丁");
  await expect
    .poll(() =>
      prompt.evaluate(
        (editor) =>
          (editor as HTMLElement & { __stablePromptEditor?: boolean }).__stablePromptEditor ===
          true,
      ),
    )
    .toBe(true);
  await expect.poll(() => prompt.evaluate(readContentEditableCaretOffset)).toBe(3);

  await page.keyboard.insertText("文");

  await expect(prompt).toHaveText("甲乙中文丙丁");
  await expect
    .poll(() =>
      prompt.evaluate(
        (editor) =>
          (editor as HTMLElement & { __stablePromptEditor?: boolean }).__stablePromptEditor ===
          true,
      ),
    )
    .toBe(true);
  await expect.poll(() => prompt.evaluate(readContentEditableCaretOffset)).toBe(4);

  await prompt.fill("甲乙丙丁");
  await prompt.evaluate((editor) => {
    const text = editor.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("Expected a plain text prompt");
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (editor as HTMLElement & { __stablePromptEditor?: boolean }).__stablePromptEditor = true;
    editor.dispatchEvent(new CompositionEvent("compositionstart", { data: "han", bubbles: true }));
    text.textContent = "甲乙汉丙丁";
    range.setStart(text, 3);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    editor.dispatchEvent(
      new InputEvent("input", { inputType: "insertCompositionText", data: "汉", bubbles: true }),
    );
    editor.dispatchEvent(new CompositionEvent("compositionend", { data: "汉", bubbles: true }));
  });

  await expect(prompt).toHaveText("甲乙汉丙丁");
  await expect
    .poll(() =>
      prompt.evaluate(
        (editor) =>
          (editor as HTMLElement & { __stablePromptEditor?: boolean }).__stablePromptEditor ===
          true,
      ),
    )
    .toBe(true);
  await expect.poll(() => prompt.evaluate(readContentEditableCaretOffset)).toBe(3);

  await prompt.fill("");
  await prompt.pressSequentially("@");
  const picker = page.getByRole("listbox", { name: "选择参考素材" });
  await expect(picker).toBeVisible();
  await picker.getByRole("option").first().click();
  await expect(picker).toBeHidden();
  await prompt.fill("@图片1 女子奔跑");
  await expect(prompt.locator("[data-reference-token]")).toHaveCount(1);
  await expect(picker).toBeHidden();
  const tokenInsertionPoint = await prompt.evaluate((editor) => {
    const text = editor.lastChild;
    if (!text || text.nodeType !== Node.TEXT_NODE)
      throw new Error("Expected text after the reference token");
    const range = document.createRange();
    range.setStart(text, 3);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    return { x: rect.left - editorRect.left, y: rect.top - editorRect.top + rect.height / 2 };
  });
  await prompt.click({ position: tokenInsertionPoint });
  await page.keyboard.insertText("快速");

  await expect(prompt).toHaveText("@图片1 女子快速奔跑");
  await expect.poll(() => prompt.evaluate(readContentEditableCaretOffset)).toBe(9);
});

test("linked materials stay direct-only and can be disconnected from the thumbnail", async ({
  page,
}) => {
  const now = Date.now();
  const projectId = "direct-only-reference-project";
  const upstreamVideoId = "indirect-video-reference";
  const directImageId = "direct-image-reference";
  const targetId = "direct-reference-target";
  const generation = {
    modelId: null,
    parameters: {},
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
    id: projectId,
    name: "直接素材链接",
    nodes: [
      {
        id: upstreamVideoId,
        type: "weftcanvas",
        position: { x: 80, y: 120 },
        data: {
          kind: "video",
          body: "间接视频素材",
          accent: "coral",
          status: "success",
          progress: null,
          media: {
            id: "local-indirect-video",
            name: "indirect-video.mp4",
            mimeType: "video/mp4",
            size: 1,
            source: "local",
            serverId: null,
            width: 1280,
            height: 720,
            durationMs: 2_000,
          },
          directorCapture: null,
          config: null,
          generation,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: directImageId,
        type: "weftcanvas",
        position: { x: 390, y: 120 },
        data: {
          kind: "image",
          body: "直接图片素材",
          accent: "blue",
          status: "success",
          progress: null,
          media: {
            id: "local-direct-image",
            name: "direct-image.png",
            mimeType: "image/png",
            size: 1,
            source: "local",
            serverId: null,
            width: 960,
            height: 540,
            durationMs: null,
          },
          directorCapture: null,
          config: null,
          generation,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: targetId,
        type: "weftcanvas",
        position: { x: 720, y: 120 },
        selected: true,
        data: {
          kind: "video",
          body: "@图片1 让画面动起来",
          accent: "coral",
          status: "idle",
          progress: null,
          media: null,
          directorCapture: null,
          config: null,
          generation: {
            ...generation,
            referenceMode: "explicit",
            referenceNodeIds: [directImageId],
          },
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
    edges: [
      { id: "indirect-video-edge", source: upstreamVideoId, target: directImageId },
      { id: "direct-image-edge", source: directImageId, target: targetId },
    ],
    groups: [],
    viewport: { x: 80, y: 170, zoom: 0.78 },
    createdAt: now,
    updatedAt: now,
  };
  await page.addInitScript(
    (seed) => {
      localStorage.clear();
      localStorage.setItem(
        `weftcanvas:project-data:v1:${encodeURIComponent(seed.project.id)}`,
        JSON.stringify(seed.project),
      );
      localStorage.setItem(
        "weftcanvas:projects:v1",
        JSON.stringify({
          version: 1,
          projects: [
            {
              id: seed.project.id,
              name: seed.project.name,
              createdAt: seed.project.createdAt,
              updatedAt: seed.project.updatedAt,
              nodeCount: seed.project.nodes.length,
            },
          ],
        }),
      );
      localStorage.setItem("weftcanvas:active-project:v1", seed.project.id);
    },
    { project },
  );

  await openCanvas(page);
  const referenceRail = page.getByLabel("已连接素材");
  await expect(referenceRail).toBeVisible();
  const chips = referenceRail.locator(".wc-node-reference-chip");
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText("直接图片素材");
  await expect(referenceRail).not.toContainText("间接视频素材");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);

  const unlink = chips.first().locator(".wc-node-reference-remove");
  await expect(unlink).toHaveAttribute("aria-label", "取消素材链接 直接图片素材");
  await expect(unlink).toHaveCSS("opacity", "0");
  await expect(unlink).toHaveCSS("pointer-events", "none");
  await expect(unlink).toHaveCSS("visibility", "hidden");
  await chips.first().hover();
  await expect(unlink).toHaveCSS("opacity", "1");
  await expect(unlink).toHaveCSS("pointer-events", "auto");
  await expect(unlink).toHaveCSS("visibility", "visible");
  const chipBox = await chips.first().boundingBox();
  const unlinkBox = await unlink.boundingBox();
  expect(chipBox).not.toBeNull();
  expect(unlinkBox).not.toBeNull();
  expect(unlinkBox!.width).toBe(18);
  expect(unlinkBox!.height).toBe(18);
  expect(
    Math.abs(unlinkBox!.x + unlinkBox!.width - chipBox!.x - chipBox!.width),
  ).toBeLessThanOrEqual(4);
  expect(unlinkBox!.y - chipBox!.y).toBeLessThanOrEqual(4);
  await unlink.click();

  await expect(referenceRail).toBeHidden();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.locator('.react-flow__edge[data-id="direct-image-edge"]')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge[data-id="indirect-video-edge"]')).toHaveCount(1);
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(3);
  await expect(page.getByLabel("视频节点提示词")).toHaveText("让画面动起来");

  await page.keyboard.press("Control+z");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.locator('.react-flow__edge[data-id="direct-image-edge"]')).toHaveCount(1);
  await expect(page.getByLabel("已连接素材")).toBeVisible();
  await expect(page.getByLabel("视频节点提示词").locator("[data-reference-token]")).toHaveAttribute(
    "data-reference-node-id",
    directImageId,
  );
});

test("node prompt composer stays operable at horizontal viewport edges", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  const viewportWidth = page.viewportSize()!.width;
  const textNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  const dragStrip = textNode.locator(".wc-node-drag-strip");
  const promptShell = page.locator(".wc-node-prompt-shell");

  const dragNodeTo = async (x: number) => {
    const stripBox = await dragStrip.boundingBox();
    expect(stripBox).not.toBeNull();
    const y = stripBox!.y + stripBox!.height / 2;
    await page.mouse.move(stripBox!.x + stripBox!.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 12 });
    await page.mouse.up();
  };

  await dragNodeTo(viewportWidth - 70);
  await expect(promptShell).toBeVisible();
  await expect
    .poll(async () => {
      const box = await promptShell.boundingBox();
      return viewportWidth - (box!.x + box!.width);
    })
    .toBeGreaterThanOrEqual(11);

  await dragNodeTo(70);
  await expect.poll(async () => (await promptShell.boundingBox())!.x).toBeGreaterThanOrEqual(11);
});

test("node prompt composer hides during node movement and returns below it after release", async ({
  page,
}) => {
  await cleanProject(page);
  await openCanvas(page);
  const viewportHeight = page.viewportSize()!.height;
  const textNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  const dragStrip = textNode.locator(".wc-node-drag-strip");
  const promptShell = page.locator(".wc-node-prompt-shell");

  const dragNodeTo = async (y: number) => {
    const stripBox = await dragStrip.boundingBox();
    expect(stripBox).not.toBeNull();
    const x = stripBox!.x + stripBox!.width / 2;
    await page.mouse.move(x, stripBox!.y + stripBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 12 });
    await expect(page.locator("body")).toHaveClass(/is-canvas-node-dragging/);
    await expect(promptShell).toHaveCSS("visibility", "hidden");
    await page.mouse.up();
    await expect(promptShell).toBeVisible();
  };
  const readVerticalGap = () =>
    page.evaluate(() => {
      const node = document.querySelector<HTMLElement>(
        '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
      );
      const overlay = document.querySelector<HTMLElement>(".wc-node-prompt-shell");
      if (!node || !overlay) return null;
      return {
        gap: overlay.getBoundingClientRect().top - node.getBoundingClientRect().bottom,
        placement: overlay.dataset.placement,
      };
    });

  await dragNodeTo(viewportHeight - 200);
  await expect.poll(readVerticalGap).toMatchObject({ placement: "below" });
  await expect.poll(async () => (await readVerticalGap())!.gap).toBeGreaterThanOrEqual(13);

  await dragNodeTo(180);
  await expect.poll(readVerticalGap).toMatchObject({ placement: "below" });
  await expect.poll(async () => (await readVerticalGap())!.gap).toBeGreaterThanOrEqual(13);
});

test("node prompt keeps twenty inline reference tokens bounded with a scrollable picker", async ({
  page,
}, testInfo) => {
  const now = Date.now();
  await page.route("**/api/v1/model-catalog", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          version: "reference-catalog",
          capabilityVersion: "reference-capability",
          pricingVersion: "reference-pricing",
          fetchedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
          quoteAvailable: true,
          models: [
            {
              id: "video-reference-model",
              label: "四图视频模型",
              description: "最多四张参考图",
              modality: "video",
              operation: "video.generate",
              order: 1,
              input: { textRequired: true, images: { min: 0, max: 4, multiple: true } },
              output: { type: "video", minCount: 1, maxCount: 1 },
              parameters: [
                {
                  name: "prompt",
                  label: "提示内容",
                  type: "string",
                  required: true,
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
            },
          ],
        },
      },
    }),
  );
  const projectId = "dense-reference-project";
  const referenceNodeIds = Array.from({ length: 20 }, (_, index) => `reference-${index + 1}`);
  const generation = {
    modelId: null,
    parameters: {},
    maxOutputTokens: null,
    referenceMode: "explicit",
    referenceNodeIds,
    jobId: null,
    jobVersion: null,
    jobCreatedAt: null,
    jobStatus: null,
    error: null,
  };
  const imageNodes = referenceNodeIds.map((id, index) => ({
    id,
    type: "weftcanvas",
    position: { x: 60 + (index % 5) * 230, y: 40 + Math.floor(index / 5) * 190 },
    data: {
      kind: "image",
      body: `参考画面 ${index + 1}`,
      accent: "blue",
      status: "success",
      progress: null,
      media: {
        id: `local-reference-${index + 1}`,
        name: `reference-${index + 1}.png`,
        mimeType: "image/png",
        size: 1,
        source: "local",
        serverId: null,
        width: 640,
        height: 360,
        durationMs: null,
      },
      directorCapture: null,
      config: null,
      generation: { ...generation, referenceMode: "auto", referenceNodeIds: [] },
      createdAt: now,
      updatedAt: now,
    },
  }));
  const targetId = "reference-target";
  const project = {
    schemaVersion: 1,
    id: projectId,
    name: "二十个参考素材",
    nodes: [
      ...imageNodes,
      {
        id: targetId,
        type: "weftcanvas",
        position: { x: 720, y: 420 },
        selected: true,
        data: {
          kind: "video",
          body: referenceNodeIds.map((_, index) => `@图片${index + 1}`).join(" "),
          accent: "coral",
          status: "idle",
          progress: null,
          media: null,
          directorCapture: null,
          config: null,
          generation,
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
    edges: imageNodes.map((node, index) => ({
      id: `reference-edge-${index + 1}`,
      source: node.id,
      target: targetId,
    })),
    groups: [],
    viewport: { x: 40, y: 100, zoom: 0.72 },
    createdAt: now,
    updatedAt: now,
  };
  await page.addInitScript(
    (seed) => {
      localStorage.clear();
      localStorage.setItem(
        `weftcanvas:project-data:v1:${encodeURIComponent(seed.project.id)}`,
        JSON.stringify(seed.project),
      );
      localStorage.setItem(
        "weftcanvas:projects:v1",
        JSON.stringify({
          version: 1,
          projects: [
            {
              id: seed.project.id,
              name: seed.project.name,
              createdAt: seed.project.createdAt,
              updatedAt: seed.project.updatedAt,
              nodeCount: seed.project.nodes.length,
            },
          ],
        }),
      );
      localStorage.setItem("weftcanvas:active-project:v1", seed.project.id);
    },
    { project },
  );

  await openCanvas(page);
  const target = page.locator(
    `.react-flow__node-weftcanvas:has(.wc-node-wrap[data-wc-node-id="${targetId}"])`,
  );
  await expect(target).toBeVisible();

  const referenceRail = page.getByLabel("已连接素材");
  await expect(referenceRail).toBeVisible();
  const prompt = page.getByLabel("视频节点提示词");
  await expect(prompt.locator("[data-reference-token]")).toHaveCount(20);
  const promptMetrics = await prompt.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(promptMetrics.height).toBeLessThanOrEqual(248);
  expect(promptMetrics.scrollWidth).toBeLessThanOrEqual(promptMetrics.clientWidth + 1);
  const railTrack = referenceRail.locator(".wc-node-reference-chips-track");
  const railMetrics = await railTrack.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(railMetrics.height).toBeLessThanOrEqual(54);
  expect(railMetrics.scrollWidth).toBeGreaterThan(railMetrics.clientWidth);

  const inlineSettings = page.getByLabel("视频节点创作设置");
  await inlineSettings.hover();
  await expect(inlineSettings.getByLabel("模型")).toContainText("四图视频模型");
  await expect(inlineSettings.getByRole("alert")).toContainText(
    "图片素材已选择 20 个，当前模型最多支持 4 个",
  );
  await expect(inlineSettings.getByRole("button", { name: "生成", exact: true })).toBeDisabled();

  await page.screenshot({ path: testInfo.outputPath("reference-rail-twenty.png") });
  await page.getByLabel("引用画布素材").click();
  const picker = page.getByRole("listbox", { name: "选择参考素材" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option")).toHaveCount(20);
  const pickerBox = await picker.boundingBox();
  expect(pickerBox).not.toBeNull();
  expect(pickerBox!.height).toBeLessThanOrEqual(280);
  const optionsBox = await picker.locator(".wc-node-reference-options").boundingBox();
  expect(optionsBox).not.toBeNull();
  expect(optionsBox!.height).toBeLessThanOrEqual(240);
  const options = picker.locator(".wc-node-reference-options");
  await options.hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(() => options.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const lastOption = picker.getByRole("option").last();
  await lastOption.scrollIntoViewIfNeeded();
  await lastOption.click();
  await expect(picker).toBeHidden();
});

test("media upload rejects disguised error payloads", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  await imageNode.locator('input[type="file"]').setInputFiles({
    name: "result.png",
    mimeType: "image/png",
    buffer: Buffer.from(JSON.stringify({ error: { message: "生成结果不可用" } })),
  });
  await expect(page.locator(".wc-toast")).toContainText("生成结果不可用");
  await expect(imageNode.locator("img")).toHaveCount(0);
  await expect(imageNode.locator(".wc-media-empty")).toBeVisible();
});

test("video nodes capture the current frame into a connected image node", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  const canvasToolbar = page.getByRole("navigation", { name: "创建工具" });
  await canvasToolbar.getByRole("button", { name: "添加视频节点" }).click();

  const nodes = page.locator(".react-flow__node-weftcanvas");
  const videoNode = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])')
    .last();
  await videoNode.locator('input[type="file"]').setInputFiles(videoFixture);
  await expect(videoNode.locator(".wc-video-playback")).toBeVisible();
  await expect(videoNode.locator(".wc-node-media-frame")).toHaveClass(/is-measured/);
  await expect(videoNode.getByLabel("视频进度")).toBeVisible();
  await expect(videoNode.locator(".wc-node-video-player > video")).toHaveCSS("object-fit", "cover");
  const duration = await videoNode.locator("video").evaluate((video) => video.duration);
  expect(duration).toBeGreaterThan(0);
  await videoNode.getByLabel("视频进度").evaluate((range, next) => {
    const input = range as HTMLInputElement;
    input.value = String(next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, duration / 2);
  await expect
    .poll(() => videoNode.locator("video").evaluate((video) => video.currentTime))
    .toBeGreaterThan(0);

  await videoNode.hover();
  const nodeToolbar = page.locator(".wc-node-action-toolbar");
  await nodeToolbar.getByLabel("截取当前帧").click();
  await expect(
    page.locator(".wc-toast").filter({ hasText: "当前画面已生成图片节点" }),
  ).toBeVisible();
  await expect(nodes).toHaveCount(5);
  await expect(
    page.locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"]) img'),
  ).toHaveCount(1);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);

  await page.keyboard.press("Control+Z");
  await expect(nodes).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
});

test("audio nodes upload, drag from the waveform, and persist", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("button", { name: "添加音频节点" })
    .click();
  const audioNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="audio"])',
  );
  await audioNode.locator('input[type="file"]').setInputFiles(audioFixture);
  await expect(audioNode.locator("audio")).toBeVisible();

  const before = await audioNode.boundingBox();
  const waveform = await audioNode.locator(".wc-audio-wave").boundingBox();
  expect(before).not.toBeNull();
  expect(waveform).not.toBeNull();
  await page.mouse.move(waveform!.x + waveform!.width / 2, waveform!.y + waveform!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    waveform!.x + waveform!.width / 2 + 92,
    waveform!.y + waveform!.height / 2 + 30,
    { steps: 8 },
  );
  await page.mouse.up();
  const after = await audioNode.boundingBox();
  expect(after!.x - before!.x).toBeGreaterThan(60);

  await audioNode.hover();
  const nodeToolbar = page.locator(".wc-node-action-toolbar");
  await expect(nodeToolbar.getByLabel("下载音频")).toBeVisible();
  await expect(nodeToolbar.getByLabel("替换音频")).toBeVisible();

  await page.waitForTimeout(460);
  await page.reload();
  await expect(
    page.locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="audio"]) audio'),
  ).toBeVisible();
});

test("empty media nodes drag without click upload and keep explicit upload available", async ({
  page,
}) => {
  await cleanProject(page);
  await openCanvas(page);
  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  const emptyMedia = imageNode.locator(".wc-media-empty");
  const before = await imageNode.boundingBox();
  const target = await emptyMedia.boundingBox();
  expect(before).not.toBeNull();
  expect(target).not.toBeNull();

  let chooserCount = 0;
  page.on("filechooser", () => {
    chooserCount += 1;
  });
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2 + 110, target!.y + target!.height / 2 + 40, {
    steps: 10,
  });
  await page.mouse.up();

  const after = await imageNode.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.x - before!.x)).toBeGreaterThan(60);
  expect(chooserCount).toBe(0);

  await emptyMedia.click();
  await page.waitForTimeout(120);
  expect(chooserCount).toBe(0);

  const canvasToolbar = page.getByRole("navigation", { name: "创建工具" });
  await canvasToolbar.getByRole("button", { name: "添加视频节点" }).click();
  const videoNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])',
  );
  await expect(videoNode.locator(".wc-media-empty svg")).toBeVisible();
  await expect(videoNode.locator(".wc-media-empty span")).toBeHidden();
  await videoNode.locator(".wc-media-empty").click();
  await page.waitForTimeout(120);
  expect(chooserCount).toBe(0);

  await canvasToolbar.getByRole("button", { name: "添加音频节点" }).click();
  const audioNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="audio"])',
  );
  await audioNode.locator(".wc-media-empty").click();
  await page.waitForTimeout(120);
  expect(chooserCount).toBe(0);
  await audioNode.locator(".wc-node-drag-strip").click();
  await expect(page.locator(".wc-node-prompt-composer")).toHaveCount(0);

  await imageNode.hover();
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".wc-node-action-toolbar").getByLabel("上传图片").click();
  await chooser;
});

test("node groups persist, move together, and remain undoable", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  const configNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="config"])',
  );
  const textNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );

  await configNode.locator(".wc-node-drag-strip").click();
  await page.keyboard.down("Control");
  await textNode.locator(".wc-node-drag-strip").click();
  await page.keyboard.up("Control");

  const groupButton = page.locator(".wc-selection-toolbar").getByLabel("组合选中节点");
  await expect(groupButton).toBeEnabled();
  await groupButton.click();
  const frame = page.locator(".wc-group-frame");
  await expect(frame).toHaveCount(1);

  await page.keyboard.press("Control+Z");
  await expect(frame).toHaveCount(0);
  await page.keyboard.press("Control+Y");
  await expect(frame).toHaveCount(1);

  const configBefore = await configNode.boundingBox();
  const textBefore = await textNode.boundingBox();
  const header = frame.locator(".wc-group-frame-header");
  const headerBox = await header.boundingBox();
  expect(configBefore).not.toBeNull();
  expect(textBefore).not.toBeNull();
  expect(headerBox).not.toBeNull();
  await page.mouse.move(headerBox!.x + 80, headerBox!.y + headerBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(headerBox!.x + 180, headerBox!.y + headerBox!.height / 2 + 54, {
    steps: 9,
  });
  await page.mouse.up();
  const configAfter = await configNode.boundingBox();
  const textAfter = await textNode.boundingBox();
  expect(configAfter!.x - configBefore!.x).toBeGreaterThan(70);
  expect(textAfter!.x - textBefore!.x).toBeGreaterThan(70);

  const groupToolbar = page.locator(".wc-group-toolbar");
  await expect(groupToolbar).toBeVisible();
  await groupToolbar.getByTitle("重命名组合").click();
  const nameInput = groupToolbar.getByLabel("组合名称");
  await nameInput.fill("第一幕");
  await nameInput.press("Enter");
  await expect(header).toContainText("第一幕");

  await page.waitForTimeout(460);
  await page.reload();
  await expect(page.locator(".wc-group-frame-header")).toContainText("第一幕");
  await page.locator(".wc-group-frame-header").hover();
  await page.locator(".wc-group-toolbar").getByLabel("解散组合").click();
  await expect(page.locator(".wc-group-frame")).toHaveCount(0);
});

test("group members drag independently and join or leave through the frozen frame", async ({
  page,
}, testInfo) => {
  await cleanProject(page);
  await openCanvas(page);
  const nodes = page.locator(".react-flow__node-weftcanvas");
  const first = nodes.nth(0);
  const second = nodes.nth(1);
  const third = nodes.nth(2);

  await first.locator(".wc-node-drag-strip").click();
  await page.keyboard.down("Control");
  await second.locator(".wc-node-drag-strip").click();
  await page.keyboard.up("Control");
  await page.locator(".wc-selection-toolbar").getByLabel("组合选中节点").click();
  await page.keyboard.press("Escape");

  const frame = page.locator(".wc-group-frame");
  const frameBeforeJoin = await frame.boundingBox();
  const thirdBeforeJoin = await third.boundingBox();
  const thirdJoinStrip = await third.locator(".wc-node-drag-strip").boundingBox();
  expect(frameBeforeJoin).not.toBeNull();
  expect(thirdBeforeJoin).not.toBeNull();
  expect(thirdJoinStrip).not.toBeNull();
  const joinTarget = {
    x: frameBeforeJoin!.x + frameBeforeJoin!.width / 2,
    y: frameBeforeJoin!.y + 34 + (frameBeforeJoin!.height - 34) / 2,
  };
  const joinDelta = {
    x: joinTarget.x - (thirdBeforeJoin!.x + thirdBeforeJoin!.width / 2),
    y: joinTarget.y - (thirdBeforeJoin!.y + thirdBeforeJoin!.height / 2),
  };
  const joinPointer = {
    x: thirdJoinStrip!.x + thirdJoinStrip!.width / 2,
    y: thirdJoinStrip!.y + thirdJoinStrip!.height / 2,
  };
  await page.mouse.move(joinPointer.x, joinPointer.y);
  await page.mouse.down();
  await page.mouse.move(joinPointer.x + joinDelta.x, joinPointer.y + joinDelta.y, { steps: 10 });
  const frameDuringJoin = await frame.boundingBox();
  expect(frameDuringJoin!.x).toBeCloseTo(frameBeforeJoin!.x, 0);
  expect(frameDuringJoin!.width).toBeCloseTo(frameBeforeJoin!.width, 0);
  await page.mouse.up();
  await expect(frame.locator(".wc-group-frame-header small")).toHaveText("3");
  await page.screenshot({ path: testInfo.outputPath("group-member-joined.png") });

  const secondBefore = await second.boundingBox();
  const firstStrip = await first.locator(".wc-node-drag-strip").boundingBox();
  expect(secondBefore).not.toBeNull();
  expect(firstStrip).not.toBeNull();
  await page.mouse.move(
    firstStrip!.x + firstStrip!.width / 2,
    firstStrip!.y + firstStrip!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    firstStrip!.x + firstStrip!.width / 2 + 28,
    firstStrip!.y + firstStrip!.height / 2 + 18,
    { steps: 7 },
  );
  await page.mouse.up();
  const secondAfterIndependentDrag = await second.boundingBox();
  expect(secondAfterIndependentDrag!.x).toBeCloseTo(secondBefore!.x, 0);
  expect(secondAfterIndependentDrag!.y).toBeCloseTo(secondBefore!.y, 0);
  await expect(frame.locator(".wc-group-frame-header small")).toHaveText("3");

  const frameBeforeLeave = await frame.boundingBox();
  const thirdBeforeLeave = await third.boundingBox();
  const thirdLeaveStrip = await third.locator(".wc-node-drag-strip").boundingBox();
  expect(frameBeforeLeave).not.toBeNull();
  expect(thirdBeforeLeave).not.toBeNull();
  expect(thirdLeaveStrip).not.toBeNull();
  const leaveTarget = {
    x: frameBeforeLeave!.x + frameBeforeLeave!.width + thirdBeforeLeave!.width + 100,
    y: frameBeforeLeave!.y + frameBeforeLeave!.height + thirdBeforeLeave!.height + 80,
  };
  const leaveDelta = {
    x: leaveTarget.x - (thirdBeforeLeave!.x + thirdBeforeLeave!.width / 2),
    y: leaveTarget.y - (thirdBeforeLeave!.y + thirdBeforeLeave!.height / 2),
  };
  const leavePointer = {
    x: thirdLeaveStrip!.x + thirdLeaveStrip!.width / 2,
    y: thirdLeaveStrip!.y + thirdLeaveStrip!.height / 2,
  };
  await page.mouse.move(leavePointer.x, leavePointer.y);
  await page.mouse.down();
  await page.mouse.move(leavePointer.x + leaveDelta.x, leavePointer.y + leaveDelta.y, {
    steps: 10,
  });
  await page.mouse.up();
  await expect(frame.locator(".wc-group-frame-header small")).toHaveText("2");
  await page.waitForTimeout(460);
  await page.reload();
  await expect(page.locator(".wc-group-frame-header small")).toHaveText("2");
});

test("group borders resize all members as one undoable persistent transform", async ({
  page,
}, testInfo) => {
  await cleanProject(page);
  await openCanvas(page);
  const nodes = page.locator(".react-flow__node-weftcanvas");
  await nodes.nth(0).locator(".wc-node-drag-strip").click();
  await page.keyboard.down("Control");
  await nodes.nth(1).locator(".wc-node-drag-strip").click();
  await page.keyboard.up("Control");
  await page.locator(".wc-selection-toolbar").getByLabel("组合选中节点").click();

  const frame = page.locator(".wc-group-frame");
  const before = await frame.boundingBox();
  const rightHandle = frame.locator('[data-wc-group-resize="right"]');
  const handle = await rightHandle.boundingBox();
  expect(before).not.toBeNull();
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 120, handle!.y + handle!.height / 2, {
    steps: 10,
  });
  await page.mouse.up();

  const resized = await frame.boundingBox();
  expect(resized!.width - before!.width).toBeGreaterThan(70);
  await page.screenshot({ path: testInfo.outputPath("group-border-resized.png") });
  await page.keyboard.press("Control+Z");
  await expect
    .poll(async () => (await frame.boundingBox())?.width ?? 0)
    .toBeCloseTo(before!.width, 0);
  await page.keyboard.press("Control+Y");
  await expect
    .poll(async () => (await frame.boundingBox())?.width ?? 0)
    .toBeCloseTo(resized!.width, 0);
  await page.waitForTimeout(460);
  await page.reload();
  await expect
    .poll(async () => (await page.locator(".wc-group-frame").boundingBox())?.width ?? 0)
    .toBeCloseTo(resized!.width, 0);
});

test("desktop layout has no document overflow", async ({ page }) => {
  await cleanProject(page);
  await openCanvas(page);
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.width);
  expect(dimensions.scrollHeight).toBe(dimensions.height);
});

test("compact desktop keeps creation, editing, and view controls separate", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await cleanProject(page);
  await openCanvas(page);

  const creation = await page.locator(".wc-create-rail").boundingBox();
  const editing = await page.locator(".wc-edit-dock").boundingBox();
  const zoom = await page.locator(".wc-zoom-control").boundingBox();
  expect(creation).not.toBeNull();
  expect(editing).not.toBeNull();
  expect(zoom).not.toBeNull();
  expect(creation!.x + creation!.width + 12).toBeLessThan(editing!.x);
  expect(zoom!.x).toBeLessThanOrEqual(18);
  expect(Math.abs(768 - (zoom!.y + zoom!.height) - 20)).toBeLessThan(3);
  expect(zoom!.y).toBeGreaterThan(creation!.y + creation!.height + 12);
  expect(zoom!.x + zoom!.width + 12).toBeLessThan(editing!.x);

  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.width);
  expect(dimensions.scrollHeight).toBe(dimensions.height);
});
