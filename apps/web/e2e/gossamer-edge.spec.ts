import { expect, type Page } from "@playwright/test";

import { seedStarterCanvas } from "./starter-canvas.fixture";
import { test } from "./zero-cost-test";

/**
 * 游丝（gossamer）线形档的实机验收。它是一根**不发光**的中性发丝，所以钉住的
 * 都是"看起来应该是什么样"：
 *   ①出现在线形组里并可切换；
 *   ②几何仍走张力档（is-taut）——游丝只换肤，不碰路径生成；
 *   ③底线 1px、无 filter、光晕整层不渲染，但能量段仍在（产品规则：连接边要有
 *     一段克制的移动能量，只是不许用辉光/模糊）；
 *   ④发丝在任意缩放下恒定（vector-effect: non-scaling-stroke），密集扇出连线
 *     不糊成一团。
 * 深浅两色与扇出图各存一张，供人眼复核对比度（浅色下最容易被吃光）。
 */
const PREFERENCES_KEY = "weftcanvas:ui-preferences:v1";

async function waitForCanvas(page: Page) {
  // 幕布是在画布渲染之后才挂上的：只等"它不在了"会在它还没出现时就通过，
  // 截图拍到的是"正在打开画布"。所以先等它挂上（可能已经闪过），再等它退场。
  await page
    .locator(".wc-canvas-entry-loader")
    .waitFor({ state: "attached", timeout: 3_000 })
    .catch(() => {});
  await expect(page.locator(".wc-canvas-entry-loader")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".react-flow__node-weftcanvas").first()).toBeVisible({
    timeout: 15_000,
  });
}

/** 一个源节点扇出到 N 个目标节点——长连线才看得出细线的成色。 */
async function seedFanCanvas(page: Page, edgePathStyle: string) {
  const now = Date.now();
  const projectId = "project-gossamer-fan";
  const node = (id: string, kind: "text" | "image", x: number, y: number, body: string) => ({
    id,
    type: "weftcanvas",
    position: { x, y },
    width: 260,
    height: 168,
    selected: false,
    data: {
      kind,
      body,
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
  const targets = Array.from({ length: 7 }, (_, index) =>
    node(`fan-target-${index}`, "image", 760, index * 260, `分镜 ${index + 1}`),
  );
  const project = {
    schemaVersion: 1,
    id: projectId,
    name: "扇出连线",
    nodes: [node("fan-source", "text", 80, 620, "同一份提示词，扇出七路"), ...targets],
    edges: targets.map((target, index) => ({
      id: `fan-edge-${index}`,
      source: "fan-source",
      target: target.id,
      selected: false,
    })),
    groups: [],
    viewport: { x: 40, y: 20, zoom: 0.72 },
    createdAt: now,
    updatedAt: now,
  };
  await page.evaluate(
    ({ projectId, project, preferencesKey, edgePathStyle }) => {
      localStorage.clear();
      localStorage.setItem(`weftcanvas:project-data:v1:${projectId}`, JSON.stringify(project));
      localStorage.setItem(
        "weftcanvas:projects:v1",
        JSON.stringify({
          version: 1,
          projects: [
            {
              id: projectId,
              name: project.name,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              nodeCount: project.nodes.length,
            },
          ],
        }),
      );
      localStorage.setItem("weftcanvas:active-project:v1", projectId);
      localStorage.setItem(preferencesKey, JSON.stringify({ edgePathStyle }));
    },
    { projectId, project, preferencesKey: PREFERENCES_KEY, edgePathStyle },
  );
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.goto("/canvas");
  await page.evaluate(() => localStorage.clear());
  await seedStarterCanvas(page);
  await page.reload();
});

test("游丝：可切换、不发光", async ({ page }, testInfo) => {
  await waitForCanvas(page);
  const edgePath = page.locator(".react-flow__edge-path").first();

  const dock = page.getByRole("navigation", { name: "编辑工具" });
  await dock.getByLabel("打开 UI 设置").click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await expect(settings).toBeVisible();
  await settings.getByRole("tab", { name: "交互" }).click();

  const edgeGroup = settings.getByRole("group", { name: "连线形态" });
  await expect(edgeGroup.getByRole("button", { name: "游丝" })).toBeVisible();
  await edgeGroup.getByRole("button", { name: "游丝" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-edge-path-style", "gossamer");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  await expect(page.locator(".wc-edge-renderer").first()).toHaveClass(/is-taut/);
  await expect(edgePath).toHaveCSS("stroke-width", "1px");
  await expect(edgePath).toHaveCSS("filter", "none");
  await expect(edgePath).toHaveCSS("vector-effect", "non-scaling-stroke");

  // 选中一条边：能量段回来，光晕仍然不渲染。
  await page.locator(".wc-edge-renderer").first().dispatchEvent("pointerdown");
  const energy = page.locator(".wc-edge-effect--stream .wc-edge-energy").first();
  await expect(energy).toBeVisible();
  await expect(energy).toHaveCSS("filter", "none");
  await expect(page.locator(".wc-edge-effect--stream .wc-edge-aura").first()).toBeHidden();

  await page.screenshot({ path: testInfo.outputPath("gossamer-dark.png") });

  // 浅色主题下复核：发丝不能被白底吃光。
  await page.evaluate(() => {
    localStorage.setItem("weftcanvas:theme-mode", "manual");
    localStorage.setItem("weftcanvas:theme", "light");
  });
  await page.reload();
  await waitForCanvas(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-edge-path-style", "gossamer");
  await expect(page.locator(".react-flow__edge-path").first()).toHaveCSS("stroke-width", "1px");
  await page.screenshot({ path: testInfo.outputPath("gossamer-light.png") });
});

test("游丝：长距离扇出连线仍是发丝", async ({ page }, testInfo) => {
  await page.goto("/canvas");
  await seedFanCanvas(page, "taut");
  await page.reload();
  await waitForCanvas(page);

  const paths = page.locator(".react-flow__edge-path");
  await expect(paths).toHaveCount(7);
  const strokeOf = (index: number) =>
    paths.nth(index).evaluate((element) => getComputedStyle(element).stroke) as Promise<string>;
  const tautStroke = await strokeOf(0);
  await page.screenshot({ path: testInfo.outputPath("gossamer-fan-taut.png") });

  await seedFanCanvas(page, "gossamer");
  await page.reload();
  await waitForCanvas(page);
  for (const index of [0, 3, 6]) {
    await expect(paths.nth(index)).toHaveCSS("stroke-width", "1px");
    await expect(paths.nth(index)).toHaveCSS("filter", "none");
    await expect(paths.nth(index)).toHaveCSS("vector-effect", "non-scaling-stroke");
  }
  // 换肤真的生效：同一张图，底线的颜色不再是默认档那支。
  expect(await strokeOf(0)).not.toBe(tautStroke);
  await page.screenshot({ path: testInfo.outputPath("gossamer-fan.png") });
});
