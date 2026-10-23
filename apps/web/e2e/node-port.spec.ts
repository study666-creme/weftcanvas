import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.addInitScript(() => {
    if (sessionStorage.getItem("weftcanvas-node-port-e2e-cleaned")) return;
    localStorage.clear();
    sessionStorage.setItem("weftcanvas-node-port-e2e-cleaned", "1");
  });
  await page.addInitScript(seedStarterGraph);
});

test("video metadata arriving during a connection drag is deferred until the drag ends", async ({
  page,
}) => {
  const projectId = "connection-media-deferral";
  const time = Date.now();
  const videoBytes = readFileSync(new URL("./video-frame.mp4", import.meta.url));
  const generation = {
    modelId: null,
    parameters: {},
    maxOutputTokens: null,
    jobId: null,
    jobVersion: null,
    jobCreatedAt: null,
    jobStatus: null,
    error: null,
  };
  const project = {
    schemaVersion: 1,
    id: projectId,
    name: "Connection media deferral",
    nodes: [
      {
        id: "source-node",
        type: "weftcanvas",
        position: { x: 40, y: 200 },
        width: 308,
        height: 176,
        selected: false,
        data: {
          kind: "text",
          body: "源节点",
          accent: "jade",
          status: "idle",
          progress: null,
          media: null,
          directorCapture: null,
          config: null,
          generation,
          createdAt: time,
          updatedAt: time,
        },
      },
      {
        id: "video-node",
        type: "weftcanvas",
        position: { x: 460, y: 200 },
        width: 340,
        height: 192,
        selected: false,
        data: {
          kind: "video",
          body: "",
          accent: "coral",
          status: "success",
          progress: null,
          media: {
            id: "defer-video-media",
            name: "video-frame.mp4",
            mimeType: "video/mp4",
            size: videoBytes.byteLength,
            source: "server",
            serverId: "defer-video-media",
            width: null,
            height: null,
            durationMs: null,
          },
          directorCapture: null,
          config: null,
          generation,
          createdAt: time,
          updatedAt: time,
        },
      },
    ],
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: time,
    updatedAt: time,
  };
  await page.addInitScript((seed) => {
    localStorage.clear();
    localStorage.setItem(
      `weftcanvas:project-data:v1:${encodeURIComponent(seed.id)}`,
      JSON.stringify(seed),
    );
    localStorage.setItem(
      "weftcanvas:projects:v1",
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: seed.id,
            name: seed.name,
            createdAt: seed.createdAt,
            updatedAt: seed.updatedAt,
            nodeCount: seed.nodes.length,
          },
        ],
      }),
    );
    localStorage.setItem("weftcanvas:active-project:v1", seed.id);
  }, project);

  let releaseVideo!: () => void;
  const videoGate = new Promise<void>((resolve) => {
    releaseVideo = resolve;
  });
  await page.route("**/api/v1/media/defer-video-media/content*", async (route) => {
    await videoGate;
    await route.fulfill({ body: videoBytes, contentType: "video/mp4" });
  });

  await page.goto("/canvas");
  const sourceNode = page.locator('.react-flow__node-weftcanvas[data-id="source-node"]');
  const videoNode = page.locator('.react-flow__node-weftcanvas[data-id="video-node"]');
  await expect(sourceNode).toBeVisible();

  const sourceHandle = sourceNode.locator(".wc-node-port-zone--right .wc-node-port");
  await sourceNode.hover();
  const sourceBox = await sourceHandle.boundingBox();
  expect(sourceBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  // Hold the connection drag over the video node area so the gesture stays active.
  const videoBoxBefore = await videoNode.boundingBox();
  expect(videoBoxBefore).not.toBeNull();
  const hold = {
    x: videoBoxBefore!.x + videoBoxBefore!.width / 2,
    y: videoBoxBefore!.y + videoBoxBefore!.height / 2,
  };
  await page.mouse.move(hold.x, hold.y, { steps: 6 });

  // While the drag is active the video metadata becomes available. The async
  // dimension writeback must be deferred, not resize the node mid-gesture.
  releaseVideo();
  await videoNode.locator("video").evaluate((element) => element.load());
  await page.waitForTimeout(400);
  const duringDrag = await videoNode.boundingBox();
  expect(duringDrag).not.toBeNull();
  expect(Math.round(duringDrag!.width)).toBe(Math.round(videoBoxBefore!.width));
  expect(Math.round(duringDrag!.height)).toBe(Math.round(videoBoxBefore!.height));

  await page.mouse.up();
  await expect
    .poll(async () => {
      const box = await videoNode.boundingBox();
      return box ? `${Math.round(box.width)}x${Math.round(box.height)}` : null;
    })
    .not.toBe(`${Math.round(videoBoxBefore!.width)}x${Math.round(videoBoxBefore!.height)}`);
  const afterDrag = await videoNode.boundingBox();
  expect(afterDrag).not.toBeNull();
  expect(afterDrag!.width).not.toBe(videoBoxBefore!.width);
});

test("node plus styles switch, persist, and share quick add behavior", async ({
  page,
}, testInfo) => {
  await page.goto("/canvas");
  const textNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  const defaultPort = textNode.locator(".wc-node-port-zone--right");

  await textNode.hover();
  await expect(defaultPort).toHaveAttribute("data-node-port-style", "classic");
  await page.screenshot({ path: testInfo.outputPath("node-port-default-classic.png") });
  await defaultPort.locator(".wc-node-port-core").click();
  await expect(defaultPort.locator(".wc-node-quick-add")).toBeVisible();
  await defaultPort.getByLabel("添加配置节点").click();
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(4);
  const addedConfigBounds = await page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="config"])')
    .last()
    .boundingBox();
  const textBounds = await textNode.boundingBox();
  const imageBounds = await page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])')
    .boundingBox();
  expect(addedConfigBounds).not.toBeNull();
  expect(textBounds).not.toBeNull();
  expect(imageBounds).not.toBeNull();
  expect(addedConfigBounds!.x).toBeGreaterThan(textBounds!.x + textBounds!.width);
  const overlapsImage =
    addedConfigBounds!.x < imageBounds!.x + imageBounds!.width &&
    addedConfigBounds!.x + addedConfigBounds!.width > imageBounds!.x &&
    addedConfigBounds!.y < imageBounds!.y + imageBounds!.height &&
    addedConfigBounds!.y + addedConfigBounds!.height > imageBounds!.y;
  expect(overlapsImage).toBe(false);

  await page.getByLabel("打开界面设置").click();
  await page.getByRole("tab", { name: "交互" }).click();
  await page
    .getByRole("group", { name: "节点加号样式" })
    .getByRole("button", { name: "简洁" })
    .click();
  await page.getByLabel("收起界面设置").click();
  await expect(textNode.locator(".wc-node-port-zone--right")).toHaveAttribute(
    "data-node-port-style",
    "compact",
  );
  await page.waitForTimeout(220);
  await page.screenshot({ path: testInfo.outputPath("node-port-compact.png") });

  await page.reload();
  const reloadedTextNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  await expect(reloadedTextNode.locator(".wc-node-port-zone--right")).toHaveAttribute(
    "data-node-port-style",
    "compact",
  );
  await reloadedTextNode.hover();
  await reloadedTextNode.locator(".wc-node-port-zone--right .wc-node-port-core").click();
  await expect(
    reloadedTextNode.locator(".wc-node-port-zone--right .wc-node-quick-add"),
  ).toBeVisible();
});

test("studio compact port keeps a quiet core and a 64px hit target", async ({ page }) => {
  await page.goto("/canvas");
  await page.getByLabel("打开界面设置").click();
  await page.getByRole("tab", { name: "交互" }).click();
  await page
    .getByRole("group", { name: "节点加号样式" })
    .getByRole("button", { name: "简洁" })
    .click();
  await page.getByLabel("收起界面设置").click();
  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  const portZone = imageNode.locator(".wc-node-port-zone--right");
  const handle = portZone.locator(".wc-node-port");
  const core = portZone.locator(".wc-node-port-core");

  await expect(portZone).toHaveAttribute("data-node-port-style", "compact");
  const restingSize = await core.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).width),
  );
  const hitTargetSize = await handle.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return {
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height),
    };
  });
  expect(restingSize).toBeCloseTo(20, 0);
  expect(hitTargetSize.width).toBeCloseTo(64, 0);
  expect(hitTargetSize.height).toBeCloseTo(64, 0);

  await portZone.hover();
  await expect
    .poll(() => core.evaluate((element) => Number.parseFloat(getComputedStyle(element).width)))
    .toBeCloseTo(28, 0);
});

test("classic plus remains interactive while moving from an unselected node into its hover zone", async ({
  page,
}) => {
  await page.goto("/canvas");
  const node = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  const zone = node.locator(".wc-node-port-zone--right");
  const handle = zone.locator(".wc-node-port");
  const core = zone.locator(".wc-node-port-core");

  await page.locator(".react-flow__pane").click({ position: { x: 1_100, y: 700 } });
  await expect(node).not.toHaveClass(/selected/);
  await node.hover();
  await expect(handle).toHaveCSS("pointer-events", "auto");
  const coreBox = await core.boundingBox();
  expect(coreBox).not.toBeNull();
  await page.mouse.move(coreBox!.x + coreBox!.width / 2, coreBox!.y + coreBox!.height / 2, {
    steps: 5,
  });

  await expect(zone).toHaveCSS("opacity", "1");
  await expect(handle).toHaveCSS("pointer-events", "auto");
  await page.mouse.click(coreBox!.x + coreBox!.width / 2, coreBox!.y + coreBox!.height / 2);
  await expect(zone.locator(".wc-node-quick-add")).toBeVisible();
});

test("classic target port stays visible and hittable while a connection drag approaches it from outside the node body", async ({
  page,
}) => {
  await page.goto("/canvas");
  const sourceNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  const targetNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  const sourceHandle = sourceNode.locator(".wc-node-port-zone--right .wc-node-port");
  const targetHandle = targetNode.locator(".wc-node-port-zone--left .wc-node-port");

  await sourceNode.hover();
  const sourceBox = await sourceHandle.boundingBox();
  expect(sourceBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();

  // Park the pointer over empty canvas so the target node is not hovered,
  // then approach the target's left port directly from outside its body.
  const targetPoint = await targetHandle.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(targetPoint.x - 130, targetPoint.y, { steps: 3 });
  const beforeReach = await targetHandle.evaluate((element) => {
    const style = getComputedStyle(element);
    return { pe: style.pointerEvents, opacity: style.opacity };
  });
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 5 });
  const reached = await targetHandle.evaluate((element) => {
    const style = getComputedStyle(element);
    return { pe: style.pointerEvents, opacity: style.opacity };
  });
  await page.mouse.up();

  // During the connection drag the classic zone is revealed globally, so the
  // target port is already interactive before the pointer crosses the body:
  // no hover mutual exclusion can make it disappear on approach.
  expect(beforeReach.pe).toBe("auto");
  expect(beforeReach.opacity).toBe("1");
  expect(reached.pe).toBe("auto");
});

test("connection can be created port-to-port after fit-view without losing the hit target", async ({
  page,
}) => {
  await page.goto("/canvas");
  const edges = page.locator(".react-flow__edge");
  const sourceNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  const targetNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="config"])',
  );
  const sourceHandle = sourceNode.locator(".wc-node-port-zone--right .wc-node-port");
  const targetHandle = targetNode.locator(".wc-node-port-zone--left .wc-node-port");

  await page.getByLabel("定位全部内容").click();
  await page.waitForTimeout(400);

  // The enlarged hit target must stay reasonably sized on screen at
  // fit-view / overview zoom, not only at 100% zoom.
  const zoomInfo = await sourceHandle.evaluate((element) => {
    const viewport = element.closest<HTMLElement>(".react-flow__viewport");
    const zoom = viewport ? new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a : 1;
    const before = getComputedStyle(element, "::before");
    return { zoom, screenPx: Number.parseFloat(before.width) * zoom };
  });
  expect(zoomInfo.screenPx).toBeGreaterThanOrEqual(24);

  const sourceBox = await sourceHandle.boundingBox();
  const targetBox = await targetHandle.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  // Track main-thread long tasks during the connection gesture so the port
  // reveal / hit-area work cannot be shown to add blocking layout thrash.
  await page.evaluate(() => {
    (window as unknown as { __kcLongTasks: number[] }).__kcLongTasks = [];
    if (typeof PerformanceObserver !== "undefined") {
      const observer = new PerformanceObserver((list) => {
        (window as unknown as { __kcLongTasks: number[] }).__kcLongTasks.push(
          ...list.getEntries().map((entry) => entry.duration),
        );
      });
      observer.observe({ type: "longtask", buffered: false });
      (window as unknown as { __kcLongTasksObserver: PerformanceObserver }).__kcLongTasksObserver =
        observer;
    }
  });
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, {
    steps: 16,
  });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const longTasks = await page.evaluate(() => {
    const tasks = (window as unknown as { __kcLongTasks: number[] }).__kcLongTasks ?? [];
    (
      window as unknown as { __kcLongTasksObserver: PerformanceObserver | undefined }
    ).__kcLongTasksObserver?.disconnect();
    return tasks;
  });
  // The port reveal / hit-area work must not add blocking layout thrash to the
  // connection gesture. Absolute long-task values swing with machine load on
  // this shared host, so the gate bounds the worst task and the total blocking
  // time instead of requiring a hard zero; a real layout regression produces
  // many large tasks and fails this bound.
  expect(Math.max(0, ...longTasks)).toBeLessThan(120);
  expect(longTasks.reduce((sum, duration) => sum + duration, 0)).toBeLessThan(250);

  await expect(edges).toHaveCount(3);
});

test("compact hit target starts an XYFlow connection outside the visual core", async ({ page }) => {
  await page.goto("/canvas");
  await page.getByLabel("打开界面设置").click();
  await page.getByRole("tab", { name: "交互" }).click();
  await page
    .getByRole("group", { name: "节点加号样式" })
    .getByRole("button", { name: "简洁" })
    .click();
  await page.getByLabel("收起界面设置").click();
  const nodes = page.locator(".react-flow__node-weftcanvas");
  const edges = page.locator(".react-flow__edge");
  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  const configNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="config"])',
  );
  const portZone = imageNode.locator(".wc-node-port-zone--right");
  const sourceHandle = imageNode.locator(".wc-node-port-zone--right .wc-node-port");
  const sourceCore = portZone.locator(".wc-node-port-core");

  await portZone.hover();
  await expect
    .poll(() =>
      sourceCore.evaluate((element) => Number.parseFloat(getComputedStyle(element).width)),
    )
    .toBeCloseTo(28, 0);
  const source = await sourceHandle.evaluate((element) => {
    const handleRect = element.getBoundingClientRect();
    const viewport = element.closest<HTMLElement>(".react-flow__viewport");
    const zoom = viewport ? new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a : 1;
    const pseudoWidth = Number.parseFloat(getComputedStyle(element, "::before").width);
    return {
      x: handleRect.x + handleRect.width / 2,
      y: handleRect.y + handleRect.height / 2,
      hitTargetDiameter: pseudoWidth * zoom,
    };
  });
  const core = await sourceCore.boundingBox();
  const target = await configNode.boundingBox();
  expect(core).not.toBeNull();
  expect(target).not.toBeNull();

  const sourceOffset = 20;
  const sourcePoint = {
    x: source.x,
    y: source.y + sourceOffset,
  };
  expect(sourceOffset).toBeGreaterThan(core!.height / 2 + 2);
  expect(sourceOffset).toBeLessThan(source.hitTargetDiameter / 2);
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  const hitHandle = await page.evaluate(
    ({ x, y }) =>
      document
        .elementFromPoint(x, y)
        ?.closest(".wc-node-port")
        ?.classList.contains("wc-node-port") ?? false,
    sourcePoint,
  );
  expect(hitHandle).toBe(true);
  await page.mouse.down();
  await page.mouse.move(target!.x + 2, target!.y + target!.height / 2, { steps: 14 });
  await page.mouse.up();

  await expect(nodes).toHaveCount(3);
  await expect(edges).toHaveCount(3);
});

test("a connection can land on a compatible node body with clear feedback", async ({
  page,
}, testInfo) => {
  await page.goto("/canvas");
  const edges = page.locator(".react-flow__edge");
  const sourceNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  const targetNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="config"])',
  );
  const sourceCore = sourceNode.locator(".wc-node-port-zone--right .wc-node-port-core");
  const targetSurface = targetNode.locator(".wc-node-surface");
  await sourceNode.hover();
  await expect(sourceCore).toBeVisible();
  const sourceBox = await sourceCore.boundingBox();
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

  await expect(targetNode).toHaveClass(/is-connection-drop-target/);
  await expect(targetNode).toHaveAttribute("data-connection-drop-side", "left");
  const feedback = await targetSurface.evaluate((element) => {
    const probe = document.createElement("i");
    probe.style.color = "color-mix(in srgb, var(--wc-success) 76%, var(--wc-text))";
    element.appendChild(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    const preview = document.querySelector<SVGPathElement>(".wc-connection-preview-base");
    return {
      expected,
      targetOutline: getComputedStyle(element).outlineColor,
      previewStroke: preview ? getComputedStyle(preview).stroke : null,
    };
  });
  expect(feedback.targetOutline).toBe(feedback.expected);
  expect(feedback.previewStroke).toBe(feedback.expected);
  await page.screenshot({
    path: testInfo.outputPath("node-body-connection-target.png"),
    fullPage: true,
  });

  await page.mouse.up();
  await expect(edges).toHaveCount(3);
  await expect(page.locator("[data-connection-create-menu]")).toHaveCount(0);
  await expect(targetNode).not.toHaveClass(/is-connection-drop-target/);
  await expect(targetNode).toHaveClass(/is-connection-drop-success/);
  await expect(targetNode).not.toHaveClass(/is-connection-drop-success/, { timeout: 1_500 });
});

test("compact plus follows the pointer and dropping on blank canvas opens connected creation", async ({
  page,
}) => {
  await page.goto("/canvas");
  await page.getByLabel("打开界面设置").click();
  await page.getByRole("tab", { name: "交互" }).click();
  await page
    .getByRole("group", { name: "节点加号样式" })
    .getByRole("button", { name: "简洁" })
    .click();
  await page.getByLabel("收起界面设置").click();
  const nodes = page.locator(".react-flow__node-weftcanvas");
  const edges = page.locator(".react-flow__edge");
  const viewport = page.locator(".react-flow__viewport");
  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  const portZone = imageNode.locator(".wc-node-port-zone--right");
  const handle = portZone.locator(".wc-node-port");
  const core = portZone.locator(".wc-node-port-core");

  await imageNode.hover();
  const coreBox = await core.boundingBox();
  expect(coreBox).not.toBeNull();
  const coreCenter = { x: coreBox!.x + coreBox!.width / 2, y: coreBox!.y + coreBox!.height / 2 };
  await page.mouse.move(coreCenter.x + 28, coreCenter.y + 10);
  const magnet = await core.evaluate((element) => ({
    x: element.style.getPropertyValue("--magnet-x"),
    y: element.style.getPropertyValue("--magnet-y"),
  }));
  expect(Math.abs(Number.parseFloat(magnet.x))).toBeGreaterThan(2);
  expect(Math.abs(Number.parseFloat(magnet.y))).toBeGreaterThan(0.5);
  await page.waitForTimeout(120);
  const pulledCoreBox = await core.boundingBox();
  expect(pulledCoreBox).not.toBeNull();
  expect(pulledCoreBox!.x + pulledCoreBox!.width / 2).toBeGreaterThan(coreCenter.x + 2);

  await page.mouse.move(coreCenter.x, coreCenter.y);
  await page.waitForTimeout(120);
  const resetCoreBox = await core.boundingBox();
  expect(resetCoreBox).not.toBeNull();
  const dragCenter = {
    x: resetCoreBox!.x + resetCoreBox!.width / 2,
    y: resetCoreBox!.y + resetCoreBox!.height / 2,
  };
  const viewportBefore = await viewport.getAttribute("style");
  const dropPoint = { x: dragCenter.x + 360, y: dragCenter.y + 230 };
  await page.mouse.move(dragCenter.x, dragCenter.y);
  await page.mouse.down();
  await page.mouse.move(dropPoint.x, dropPoint.y, { steps: 16 });
  await page.mouse.up();

  expect(await viewport.getAttribute("style")).toBe(viewportBefore);
  const menu = page.getByRole("menu", { name: "选择要连接创建的节点" });
  await expect(menu).toBeVisible();
  // 快捷创建条必须是单排：所有选项的垂直中心落在同一行内。
  const optionBoxes = await menu.getByRole("menuitem").evaluateAll((items) =>
    items.map((item) => {
      const box = item.getBoundingClientRect();
      return { centerY: box.y + box.height / 2, height: box.height };
    }),
  );
  expect(optionBoxes.length).toBeGreaterThan(1);
  const spread =
    Math.max(...optionBoxes.map((box) => box.centerY)) -
    Math.min(...optionBoxes.map((box) => box.centerY));
  expect(spread).toBeLessThan(2);
  expect(Math.max(...optionBoxes.map((box) => box.height))).toBeLessThan(40);
  await menu.getByLabel("创建并连接视频节点").click();
  await expect(nodes).toHaveCount(4);
  await expect(edges).toHaveCount(3);
  const createdVideo = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])')
    .last();
  const createdBox = await createdVideo.boundingBox();
  expect(createdBox).not.toBeNull();
  expect(Math.abs(createdBox!.x - dropPoint.x)).toBeLessThan(6);
  expect(Math.abs(createdBox!.y + createdBox!.height / 2 - dropPoint.y)).toBeLessThan(6);
});

test("connection paths meet node edges while visual plus controls float outside", async ({
  page,
}) => {
  await page.goto("/canvas");

  const geometry = await page
    .locator(".react-flow__edge")
    .last()
    .evaluate((edge) => {
      const label = edge.getAttribute("aria-label") || "";
      const match = /^Edge from (.+) to (.+)$/.exec(label);
      const path = edge.querySelector<SVGPathElement>(".react-flow__edge-path");
      const matrix = path?.getScreenCTM();
      if (!match || !path || !matrix) return null;
      const source = document.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(match[1]!)}"]`,
      );
      const target = document.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(match[2]!)}"]`,
      );
      if (!source || !target) return null;
      const screenPoint = (length: number) => {
        const point = path.getPointAtLength(length);
        const transformed = new DOMPoint(point.x, point.y).matrixTransform(matrix);
        return { x: transformed.x, y: transformed.y };
      };
      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return {
        start: screenPoint(0),
        end: screenPoint(path.getTotalLength()),
        source: { right: sourceRect.right, top: sourceRect.top, bottom: sourceRect.bottom },
        target: { left: targetRect.left, top: targetRect.top, bottom: targetRect.bottom },
      };
    });

  expect(geometry).not.toBeNull();
  expect(Math.abs(geometry!.start.x - geometry!.source.right)).toBeLessThanOrEqual(2);
  expect(Math.abs(geometry!.end.x - geometry!.target.left)).toBeLessThanOrEqual(2);
  expect(geometry!.start.y).toBeGreaterThanOrEqual(geometry!.source.top);
  expect(geometry!.start.y).toBeLessThanOrEqual(geometry!.source.bottom);
  expect(geometry!.end.y).toBeGreaterThanOrEqual(geometry!.target.top);
  expect(geometry!.end.y).toBeLessThanOrEqual(geometry!.target.bottom);
});

test("connection energy appears only for selected endpoints or edges", async ({ page }) => {
  await page.goto("/canvas");
  const edge = page.locator(".react-flow__edge").first();
  await expect(edge).toBeAttached();
  await expect(
    edge.locator('.wc-edge-renderer[data-edge-energy-ambient="false"] .wc-edge-energy'),
  ).toHaveCount(0);

  const connectedConfig = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="config"])',
  );
  await connectedConfig.locator(".wc-node-drag-strip").click();
  await expect(
    page.locator('.wc-edge-renderer[data-edge-energy-active="true"] .wc-edge-energy'),
  ).toHaveCount(1);
  await page.locator(".react-flow__pane").click({ position: { x: 1_080, y: 650 } });
  await expect(page.locator('.wc-edge-renderer[data-edge-energy-active="true"]')).toHaveCount(0);
  await expect(
    edge.locator('.wc-edge-renderer[data-edge-energy-ambient="false"] .wc-edge-energy'),
  ).toHaveCount(0);

  await edge.locator(".react-flow__edge-interaction").click({ force: true });
  await expect(edge).toHaveClass(/selected/);
  await expect(edge.locator('.wc-edge-renderer[data-edge-energy-active="true"]')).toHaveCount(1);
  const energy = edge.locator(".wc-edge-energy");
  await expect(energy).toHaveCount(1);

  const before = await energy.evaluate((element) => {
    const animation = element.getAnimations()[0];
    return {
      opacity: Number(getComputedStyle(element).opacity),
      playState: animation?.playState ?? "missing",
      currentTime: Number(animation?.currentTime ?? 0),
    };
  });
  expect(before.opacity).toBeGreaterThanOrEqual(0.9);
  expect(before.playState).toBe("running");

  await page.waitForTimeout(180);
  const after = await energy.evaluate((element) =>
    Number(element.getAnimations()[0]?.currentTime ?? 0),
  );
  expect(after).toBeGreaterThan(before.currentTime);

  await page.locator(".react-flow__pane").click({ position: { x: 1_080, y: 650 } });
  await expect(
    edge.locator('.wc-edge-renderer[data-edge-energy-ambient="false"] .wc-edge-energy'),
  ).toHaveCount(0);
});

test("deleting a clicked connection keeps both endpoint nodes", async ({ page }) => {
  await page.goto("/canvas");
  const nodes = page.locator(".react-flow__node-weftcanvas");
  const edges = page.locator(".react-flow__edge");
  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );

  await imageNode.locator(".wc-node-drag-strip").click();
  await expect(imageNode).toHaveClass(/selected/);
  const edgeId = await edges.first().getAttribute("data-id");
  const edge = page.locator(`.react-flow__edge[data-id="${edgeId}"]`);
  const hitPoint = await edge
    .locator(".react-flow__edge-path")
    .evaluate((element, expectedEdgeId) => {
      const path = element as SVGPathElement;
      const matrix = path.getScreenCTM();
      if (!matrix) return null;
      const length = path.getTotalLength();
      for (let step = 2; step <= 18; step += 1) {
        const point = path.getPointAtLength((length * step) / 20);
        const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
        const wrapper = document.elementFromPoint(screen.x, screen.y)?.closest(".react-flow__edge");
        if (wrapper?.getAttribute("data-id") === expectedEdgeId)
          return { x: screen.x, y: screen.y };
      }
      return null;
    }, edgeId);
  expect(hitPoint).not.toBeNull();
  await page.mouse.click(hitPoint!.x, hitPoint!.y);
  await expect(edge).toHaveClass(/selected/);
  await expect(imageNode).not.toHaveClass(/selected/);

  await page.getByRole("button", { name: "删除选中内容" }).click();
  await expect(nodes).toHaveCount(3);
  await expect(edges).toHaveCount(1);

  await page.keyboard.press("Control+Z");
  await expect(nodes).toHaveCount(3);
  await expect(edges).toHaveCount(2);
});

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
  const text = {
    id: "starter-text",
    type: "weftcanvas",
    position: { x: 40, y: 40 },
    width: 308,
    height: 176,
    data: nodeData("text", {
      body: "低机位跟拍，湿润石板路反射零散霓虹。人物从画面右侧冲入，急促回头，远处渡轮鸣笛。",
    }),
  };
  const config = {
    id: "starter-config",
    type: "weftcanvas",
    position: { x: 40, y: 260 },
    width: 308,
    height: 176,
    data: nodeData("config"),
  };
  const image = {
    id: "starter-image",
    type: "weftcanvas",
    position: { x: 440, y: 42 },
    width: 340,
    height: 191,
    data: nodeData("image", { body: "16:9 · 冷雨夜 · 暖色实景光" }),
  };
  const project = {
    schemaVersion: 1,
    id: "node-port-starter",
    name: "连接端口画布",
    nodes: [text, config, image],
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
