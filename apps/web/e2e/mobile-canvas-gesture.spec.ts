import { expect, test, type CDPSession, type Page } from "@playwright/test";

import { mockAuthenticatedSession } from "./canvas-ui.fixture";

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});

test.beforeEach(async ({ page }) => {
  await mockAuthenticatedSession(page);
  await page.route("**/api/v1/model-catalog?*", (route) => {
    const now = new Date();
    return route.fulfill({
      json: {
        ok: true,
        data: {
          version: "mobile-gesture-catalog",
          capabilityVersion: "mobile-gesture-capability",
          pricingVersion: "mobile-gesture-pricing",
          fetchedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
          quoteAvailable: false,
          models: [],
        },
      },
    });
  });

  await seedEmptyProject(page);
  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 6_000 });
});

test("coarse touch devices pan and zoom the canvas with two fingers", async ({ page, context }) => {
  expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)).toBe(true);

  const client = await context.newCDPSession(page);
  const flow = page.locator(".react-flow__pane");
  const bounds = await flow.boundingBox();
  expect(bounds).not.toBeNull();

  const center = {
    x: bounds!.x + bounds!.width * 0.52,
    y: bounds!.y + bounds!.height * 0.52,
  };
  const readViewport = () => page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
  });

  const initial = await readViewport();
  await dispatchGesture(client, [
    [touch(1, center.x - 52, center.y), touch(2, center.x + 52, center.y)],
    [touch(1, center.x - 20, center.y + 54), touch(2, center.x + 84, center.y + 54)],
  ]);

  await expect.poll(readViewport).not.toEqual(initial);
  const panned = await readViewport();
  expect(panned.zoom).toBeCloseTo(initial.zoom, 2);
  expect(panned.x - initial.x).toBeGreaterThan(20);
  expect(panned.y - initial.y).toBeGreaterThan(35);

  await dispatchGesture(client, [
    [touch(1, center.x - 42, center.y), touch(2, center.x + 42, center.y)],
    [touch(1, center.x - 92, center.y), touch(2, center.x + 92, center.y)],
  ]);

  await expect.poll(async () => (await readViewport()).zoom).toBeGreaterThan(panned.zoom * 1.5);
  const zoomedIn = await readViewport();

  await dispatchGesture(client, [
    [touch(1, center.x - 92, center.y), touch(2, center.x + 92, center.y)],
    [touch(1, center.x - 42, center.y), touch(2, center.x + 42, center.y)],
  ]);

  await expect.poll(async () => (await readViewport()).zoom).toBeLessThan(zoomedIn.zoom * 0.75);
});

test("a single blank-canvas touch leaves the entire viewport unchanged", async ({ page, context }) => {
  const client = await context.newCDPSession(page);
  const bounds = await page.locator(".react-flow__pane").boundingBox();
  expect(bounds).not.toBeNull();

  const readViewport = () => page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
  });
  const before = await readViewport();
  const start = touch(1, bounds!.x + bounds!.width * 0.6, bounds!.y + bounds!.height * 0.58);
  const end = touch(1, start.x + 70, start.y + 46);

  await dispatchGesture(client, [[start], [end]]);
  expect(await readViewport()).toEqual(before);
});

test("starting a two-finger gesture never opens mobile marquee selection", async ({ page, context }) => {
  const client = await context.newCDPSession(page);
  const bounds = await page.locator(".react-flow__pane").boundingBox();
  expect(bounds).not.toBeNull();

  const readViewport = () => page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
  });
  const before = await readViewport();
  const firstStart = touch(1, bounds!.x + bounds!.width * 0.42, bounds!.y + bounds!.height * 0.48);
  const firstMoved = touch(1, firstStart.x + 28, firstStart.y + 18);

  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [firstStart] });
  await moveTouches(client, [firstStart], [firstMoved]);
  await expect(page.locator(".react-flow__selection")).toHaveCount(0);

  const secondStart = touch(2, firstMoved.x + 92, firstMoved.y);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [firstMoved, secondStart],
  });
  await moveTouches(client, [firstMoved, secondStart], [
    touch(1, firstMoved.x - 24, firstMoved.y + 46),
    touch(2, secondStart.x + 38, secondStart.y + 46),
  ]);
  await expect(page.locator(".react-flow__selection")).toHaveCount(0);
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  await expect.poll(readViewport).not.toEqual(before);
});

test("two-finger navigation can start on a node and leaves node dragging usable", async ({ page, context }) => {
  const client = await context.newCDPSession(page);
  await page.locator(".kc-create-rail-node-group button").first().click();

  const node = page.locator(".react-flow__node-kachang");
  await expect(node).toHaveCount(1);
  await page.waitForTimeout(220);

  const readNodePosition = () => node.evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42 };
  });
  const readViewport = () => page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
  });

  const nodeBounds = await node.boundingBox();
  expect(nodeBounds).not.toBeNull();
  const nodePositionBeforeGesture = await readNodePosition();
  const viewportBeforeGesture = await readViewport();
  const centerY = nodeBounds!.y + nodeBounds!.height * 0.46;
  await dispatchGesture(client, [
    [
      touch(1, nodeBounds!.x + nodeBounds!.width * 0.38, centerY),
      touch(2, nodeBounds!.x + nodeBounds!.width * 0.62, centerY),
    ],
    [
      touch(1, nodeBounds!.x + nodeBounds!.width * 0.26 + 24, centerY + 38),
      touch(2, nodeBounds!.x + nodeBounds!.width * 0.74 + 24, centerY + 38),
    ],
  ]);

  await expect.poll(async () => (await readViewport()).zoom).toBeGreaterThan(viewportBeforeGesture.zoom * 1.4);
  expect(await readNodePosition()).toEqual(nodePositionBeforeGesture);

  const dragStrip = node.locator(".kc-node-drag-strip");
  let dragBounds = await dragStrip.boundingBox();
  expect(dragBounds).not.toBeNull();
  const nodePositionBeforeInterruptedDrag = await readNodePosition();
  const interruptedStart = touch(1, dragBounds!.x + dragBounds!.width * 0.5, dragBounds!.y + dragBounds!.height * 0.5);
  const interruptedMove = touch(1, interruptedStart.x + 34, interruptedStart.y + 22);
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [interruptedStart] });
  await moveTouches(client, [interruptedStart], [interruptedMove]);
  await expect.poll(readNodePosition).not.toEqual(nodePositionBeforeInterruptedDrag);

  const secondStart = touch(2, interruptedMove.x + 74, interruptedMove.y);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [interruptedMove, secondStart],
  });
  await moveTouches(client, [interruptedMove, secondStart], [
    touch(1, interruptedMove.x - 24, interruptedMove.y + 28),
    touch(2, secondStart.x + 46, secondStart.y + 28),
  ]);
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(node).not.toHaveClass(/dragging/);

  await page.keyboard.press("Control+Z");
  await expect.poll(readNodePosition).toEqual(nodePositionBeforeInterruptedDrag);

  dragBounds = await dragStrip.boundingBox();
  expect(dragBounds).not.toBeNull();
  const nodePositionBeforeDrag = await readNodePosition();
  const dragStart = touch(1, dragBounds!.x + dragBounds!.width * 0.5, dragBounds!.y + dragBounds!.height * 0.5);
  await dispatchGesture(client, [[dragStart], [touch(1, dragStart.x + 54, dragStart.y + 38)]]);

  await expect.poll(readNodePosition).not.toEqual(nodePositionBeforeDrag);
});

test("mobile canvas controls stay inside the viewport without overlapping", async ({ page }) => {
  const selectors = [
    ".kc-project-console",
    ".kc-topbar-actions",
    ".kc-agent-companion",
    ".kc-create-rail",
    ".kc-edit-dock",
    ".kc-zoom-control",
  ];
  const boxes = await page.locator(selectors.join(",")).evaluateAll((elements, candidates) => Object.fromEntries(
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      const name = candidates.find((selector) => element.matches(selector))!;
      return [name, { left: box.left, top: box.top, right: box.right, bottom: box.bottom }];
    }),
  ), selectors);

  for (const box of Object.values(boxes)) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(390);
    expect(box.bottom).toBeLessThanOrEqual(844);
  }
  expect(overlaps(boxes[".kc-project-console"], boxes[".kc-agent-companion"])).toBe(false);
  expect(overlaps(boxes[".kc-project-console"], boxes[".kc-topbar-actions"])).toBe(false);
  expect(overlaps(boxes[".kc-edit-dock"], boxes[".kc-zoom-control"])).toBe(false);
});

type TouchPoint = {
  id: number;
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  force: number;
};

function touch(id: number, x: number, y: number): TouchPoint {
  return { id, x, y, radiusX: 4, radiusY: 4, force: 0.5 };
}

async function dispatchGesture(client: CDPSession, keyframes: TouchPoint[][]) {
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: keyframes[0] });
  for (let index = 1; index < keyframes.length; index += 1) {
    await moveTouches(client, keyframes[index - 1], keyframes[index]);
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function moveTouches(client: CDPSession, from: TouchPoint[], to: TouchPoint[]) {
  for (let step = 1; step <= 8; step += 1) {
    const progress = step / 8;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: from.map((point, pointIndex) => ({
        ...point,
        x: point.x + (to[pointIndex].x - point.x) * progress,
        y: point.y + (to[pointIndex].y - point.y) * progress,
      })),
    });
  }
}

async function seedEmptyProject(page: Page) {
  const now = Date.now();
  const project = {
    schemaVersion: 1,
    id: "mobile-gesture-project",
    name: "Mobile gesture",
    nodes: [],
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: now,
    updatedAt: now,
  };

  await page.addInitScript((seed) => {
    localStorage.clear();
    localStorage.setItem(
      `kachang-canvas:project-data:v1:${encodeURIComponent(seed.id)}`,
      JSON.stringify(seed),
    );
    localStorage.setItem("kachang-canvas:projects:v1", JSON.stringify({
      version: 1,
      projects: [{
        id: seed.id,
        name: seed.name,
        createdAt: seed.createdAt,
        updatedAt: seed.updatedAt,
        nodeCount: 0,
      }],
    }));
    localStorage.setItem("kachang-canvas:active-project:v1", seed.id);
  }, project);
}

function overlaps(
  first: { left: number; top: number; right: number; bottom: number },
  second: { left: number; top: number; right: number; bottom: number },
) {
  return first.left < second.right
    && first.right > second.left
    && first.top < second.bottom
    && first.bottom > second.top;
}
