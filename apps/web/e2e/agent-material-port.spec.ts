import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { skipOnboardingTour } from "./onboarding.fixture";

/**
 * Agent 引用口：抽屉打开时画布列右侧的圆形加号。把图片/视频节点拖线到它（或直接把节点
 * 拖上去）= 引用给 Agent，发送对话时作为参考素材。它是画布之上的固定浮层，不是节点。
 */

const IMAGE = readFileSync(fileURLToPath(new URL("./docs-canvas-portrait.jpg", import.meta.url)));

test.beforeEach(async ({ page }) => {
  await skipOnboardingTour(page);
  await page.route("**/api/v1/media/*/content**", (route) =>
    route.fulfill({ contentType: "image/jpeg", body: IMAGE }),
  );
  await page.route(/\/api\/v1\/auth\/session(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          user: {
            id: "88888888-8888-4888-8888-888888888888",
            email: "agent-port@example.com",
            displayName: "引用测试",
            createdAt: "2026-07-22T00:00:00.000Z",
          },
          expiresAt: "2099-08-22T00:00:00.000Z",
        },
      },
    }),
  );
  await seedProject(page);
  await page.goto("/canvas");
  await expect(page.locator('.react-flow__node[data-id="img-a"] img')).toBeVisible();
  await page.getByLabel("打开画布 Agent").click();
  await expect(port(page)).toBeVisible();
});

function port(page: Page) {
  return page.locator(".wc-agent-port");
}

async function center(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not visible`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** 从节点右侧端口按住拖到目标点；`beforeRelease` 在松手前执行（用来断言悬停态）。 */
async function dragLine(
  page: Page,
  nodeId: string,
  target: { x: number; y: number },
  beforeRelease?: () => Promise<void>,
) {
  // 先悬停节点把端口显出来再按下去：端口默认 opacity:0 / pointer-events:none，
  // 直接落在边缘那一像素上，不同的字号/缩放会让命中测试落回画布。
  const nodeBox = (await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox())!;
  await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
  const start = await center(
    page,
    `.react-flow__node[data-id="${nodeId}"] [data-handleid="right-source"]`,
  );
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + target.x) / 2, (start.y + target.y) / 2, { steps: 6 });
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await beforeRelease?.();
  await page.mouse.up();
}

function viewportTransform(page: Page) {
  return page
    .locator(".react-flow__viewport")
    .evaluate((element) => getComputedStyle(element).transform);
}

function linkedIds(page: Page) {
  return page.evaluate(
    () =>
      (
        JSON.parse(localStorage.getItem("weftcanvas:agent-links:v1") ?? "{}") as Record<
          string,
          string[]
        >
      )["agent-port-project"] ?? [],
  );
}

test("dragging an image line onto the port references it without panning the canvas", async ({
  page,
}, testInfo) => {
  const before = await viewportTransform(page);
  const target = await center(page, ".wc-agent-port");

  await dragLine(page, "img-a", target, async () => {
    // 能引用的素材：引用口亮起，悬停时说明松手的结果。
    await expect(port(page)).toHaveAttribute("data-drop", "ready");
    await expect(port(page)).toHaveAttribute("data-drop-hover", "");
    await expect(port(page).locator(".wc-agent-port-hint")).toHaveText("松手引用给 Agent");
    await page.screenshot({ path: testInfo.outputPath("agent-port-hover-ready.png") });
  });

  await expect.poll(() => linkedIds(page)).toEqual(["img-a"]);
  await expect(port(page).locator("i")).toHaveText("1");
  await expect(port(page)).not.toHaveAttribute("data-drop", /.+/);
  await expect(page.getByText("已把「portrait-a.jpg」引用给 Agent")).toBeVisible();
  // 引用口在抽屉左缘那一列（不在画布里）：拖线过去不该把画布带着滑走，也不该弹「新建节点」菜单。
  expect(await viewportTransform(page)).toBe(before);
  await expect(page.locator(".wc-connection-create-menu")).toHaveCount(0);
  // 抽屉素材条出现这条引用，带缩略图。
  const chip = page.locator(".wc-agent-link-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("portrait-a.jpg");
  await expect(chip.locator(".wc-agent-material-thumb img")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("agent-port-linked.png") });

  // 同一张再拖一次：说明已经引用过，不会被取消掉。
  await dragLine(page, "img-a", target);
  await expect(page.getByText("这个节点已经引用给 Agent 了")).toBeVisible();
  expect(await linkedIds(page)).toEqual(["img-a"]);
});

test("a near miss inside the halo still lands on the port", async ({ page }) => {
  const box = (await port(page).boundingBox())!;
  // 落在圆外 10px（命中区外扩 14px）。
  await dragLine(page, "img-b", { x: box.x - 10, y: box.y + box.height / 2 });
  await expect.poll(() => linkedIds(page)).toEqual(["img-b"]);
  await expect(page.locator(".wc-connection-create-menu")).toHaveCount(0);
});

test("a text node is refused with the reason instead of failing silently", async ({
  page,
}, testInfo) => {
  const target = await center(page, ".wc-agent-port");
  await dragLine(page, "txt-a", target, async () => {
    await expect(port(page)).toHaveAttribute("data-drop", "blocked");
    await expect(port(page).locator(".wc-agent-port-hint")).toHaveText(
      "只有带图片或视频的节点能引用给 Agent",
    );
    await page.screenshot({ path: testInfo.outputPath("agent-port-hover-blocked.png") });
  });
  await expect(page.getByText("只有带图片或视频的节点能引用给 Agent").last()).toBeVisible();
  expect(await linkedIds(page)).toEqual([]);
  await expect(page.locator(".wc-connection-create-menu")).toHaveCount(0);
});

test("dragging the whole node onto the port also references it", async ({ page }) => {
  const box = (await page.locator('.react-flow__node[data-id="img-b"]').boundingBox())!;
  const target = await center(page, ".wc-agent-port");
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 14 });
  await page.mouse.up();
  await expect.poll(() => linkedIds(page)).toEqual(["img-b"]);
});

test("the port stays fixed while the canvas pans underneath", async ({ page }) => {
  const before = (await port(page).boundingBox())!;
  const nodeBefore = (await page.locator('.react-flow__node[data-id="img-a"]').boundingBox())!;
  await page.mouse.move(600, 600);
  await page.mouse.wheel(220, 160);
  await expect
    .poll(async () => (await page.locator('.react-flow__node[data-id="img-a"]').boundingBox())!.x)
    .not.toBe(nodeBefore.x);
  expect(await port(page).boundingBox()).toEqual(before);
});

test("the port hugs the agent panel's left edge", async ({ page }) => {
  // 抽屉入场有 26px 的滑入动画，等它落定再量。
  await page.waitForTimeout(320);
  const portBox = (await port(page).boundingBox())!;
  const drawerBox = (await page.locator(".wc-agent-drawer").boundingBox())!;
  const gap = drawerBox.x - (portBox.x + portBox.width);
  // 和节点加号同一套落位：贴着面板边缘、落在面板外面，不压住对话与输入区。
  expect(gap).toBeGreaterThan(-2);
  expect(gap).toBeLessThanOrEqual(14);
  // 纵向以面板为中心。
  expect(
    Math.abs(portBox.y + portBox.height / 2 - (drawerBox.y + drawerBox.height / 2)),
  ).toBeLessThanOrEqual(2);
});

test("the picker lists media nodes with thumbnails and toggles references", async ({ page }) => {
  await port(page).getByRole("button", { name: "引用素材给 Agent" }).click();
  const popup = page.getByRole("group", { name: "引用素材给 Agent" });
  await expect(popup).toContainText("0/8");
  const options = popup.getByRole("option");
  // 只列带图片/视频的节点，文本节点不在里面。
  await expect(options).toHaveCount(2);
  await expect(options.first().locator(".wc-agent-material-thumb img")).toBeVisible();
  await options.first().click();
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(popup).toContainText("1/8");
  await options.first().click();
  await expect(options.first()).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});

async function seedProject(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("agent-port-seeded")) return;
    sessionStorage.setItem("agent-port-seeded", "1");
    const now = Date.now();
    const node = (
      id: string,
      kind: "image" | "text",
      x: number,
      y: number,
      mediaId: string | null,
    ) => ({
      id,
      type: "weftcanvas",
      position: { x, y },
      width: 280,
      height: 280,
      selected: false,
      data: {
        kind,
        body: kind === "text" ? "一段说明文字" : "",
        accent: "jade",
        status: mediaId ? "success" : "idle",
        progress: null,
        media: mediaId
          ? {
              id: mediaId,
              name: `${mediaId}.jpg`,
              mimeType: "image/jpeg",
              size: 155_719,
              source: "server",
              serverId: mediaId,
              width: 900,
              height: 1200,
              durationMs: null,
            }
          : null,
        directorCapture: null,
        config: null,
        generation: {
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
        },
        createdAt: now,
        updatedAt: now,
      },
    });
    const project = {
      schemaVersion: 1,
      id: "agent-port-project",
      name: "Agent 引用口",
      nodes: [
        node("img-a", "image", 80, 80, "portrait-a"),
        node("img-b", "image", 80, 420, "portrait-b"),
        node("txt-a", "text", 440, 160, null),
      ],
      edges: [],
      groups: [],
      viewport: { x: 40, y: 40, zoom: 0.8 },
      createdAt: now,
      updatedAt: now,
    };
    localStorage.setItem(`weftcanvas:project-data:v1:${project.id}`, JSON.stringify(project));
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
    localStorage.removeItem("weftcanvas:agent-links:v1");
  });
}
