import { expect, test, type Page } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";
import { skipOnboardingTour } from "./onboarding.fixture";

/**
 * 导入第三方画布（LibTV / TapNow / UpDream）。
 *
 * 本机 e2e 没有 API，所以三个接口一律 mock：这里验的是入口、菜单可用性、
 * 预览文案、确认导入后画布真的多出节点与连线，以及读不到时如实报错。
 * 服务端的协议解析、域名白名单与代拉门槛由 apps/api 的单元/路由测试覆盖。
 */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const PREVIEW = {
  ok: true,
  data: {
    provider: "tapnow",
    sourceId: "Share-1",
    projectName: "短剧画布",
    batchId: "tapnow-1-abcdefgh",
    nodes: [
      {
        key: "n1",
        kind: "text",
        title: "开场",
        body: "深夜的医院走廊",
        prompt: "",
        model: "",
        position: { x: 0, y: 0 },
        width: 300,
        height: 180,
        status: "success",
        error: "",
        sourceType: "text",
        asset: null,
      },
      {
        key: "n2",
        kind: "image",
        title: "场景图",
        body: "",
        prompt: "深夜医院",
        model: "seedream",
        position: { x: 400, y: 0 },
        width: 360,
        height: 360,
        status: "success",
        error: "",
        sourceType: "image",
        asset: {
          path: "/api/v1/canvas-import/asset?p=tapnow&u=x",
          mimeType: "image/png",
          width: 1,
          height: 1,
          durationMs: null,
        },
      },
    ],
    edges: [{ key: "e1", source: "n1", target: "n2" }],
    skipped: [],
    warnings: [{ id: "", message: "TapNow 节点「另一个镜头」没有可导入的素材" }],
  },
};

async function openCanvas(page: Page) {
  await page.goto("/canvas");
  await expect(page.locator(".react-flow__renderer")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".wc-canvas-entry-loader")).toHaveCount(0, { timeout: 20_000 });
}

async function mockCanvasBasics(page: Page, providers?: unknown) {
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
          version: "import-e2e",
          capabilityVersion: "import-e2e",
          pricingVersion: "import-e2e",
          fetchedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
          quoteAvailable: false,
          models: [],
        },
      },
    });
  });
  await page.route("**/api/v1/canvas-import/providers", (route) =>
    route.fulfill({
      json: providers ?? {
        ok: true,
        data: {
          providers: [
            { provider: "libtv", available: false, reason: "服务端尚未配置 LIBTV_CANVAS_TOKEN" },
            { provider: "tapnow", available: true, reason: "" },
            { provider: "updream", available: true, reason: "" },
          ],
        },
      },
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("weftcanvas:onboarding:v1", "done");
  });
  await skipOnboardingTour(page);
});

test("顶栏入口列出三个来源，不可用的来源说明差什么", async ({ page }, testInfo) => {
  await mockCanvasBasics(page);
  await openCanvas(page);

  await page.getByLabel("导入第三方画布").click();
  const menu = page.locator(".wc-canvas-import-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([
    /导入 LibTV 画布/,
    /导入 TapNow 画布/,
    /导入 UpDream 画布/,
  ]);
  await expect(menu.getByRole("menuitem", { name: /LibTV/ })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: /LibTV/ })).toContainText("未配置");
  await expect(menu.getByRole("menuitem", { name: /TapNow/ })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("canvas-import-menu.png") });

  // 点空白处收起；再按 Escape 也能收起。
  await page.mouse.click(640, 500);
  await expect(menu).toHaveCount(0);
  await page.getByLabel("导入第三方画布").click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("确认导入后画布多出节点与连线，素材落进本地媒体库", async ({ page }, testInfo) => {
  await mockCanvasBasics(page);
  await page.route("**/api/v1/canvas-import/preview", (route) => route.fulfill({ json: PREVIEW }));
  await page.route("**/api/v1/canvas-import/asset?*", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }),
  );
  await openCanvas(page);

  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);

  await page.getByLabel("导入第三方画布").click();
  await page.getByRole("menuitem", { name: /TapNow/ }).click();

  const dialog = page.getByRole("dialog", { name: /导入 TapNow 画布/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("粘贴 TapNow 分享链接");
  await page.screenshot({ path: testInfo.outputPath("canvas-import-dialog.png") });

  await dialog
    .getByLabel("粘贴 TapNow 分享链接或分享 ID")
    .fill("https://app.tapnow.media/tapflow/view/Share-1");
  await dialog.getByRole("button", { name: "读取画布" }).click();

  const summary = page.locator("[data-wc-canvas-import-summary]");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("短剧画布");
  await expect(summary).toContainText("2 个节点 · 1 条连线");
  await expect(summary).toContainText("1 条提醒");
  await page.screenshot({ path: testInfo.outputPath("canvas-import-preview.png") });

  await page.locator("[data-wc-canvas-import-confirm]").click();
  await expect(dialog).toHaveCount(0);

  // 节点、连线、正文与素材都真的落到画布上。
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.locator(".react-flow__node-weftcanvas").first()).toContainText(
    "深夜的医院走廊",
  );
  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  await expect(imageNode.locator("img")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("canvas-import-applied.png") });
});

test("读不到来源时如实报错，画布上不留任何节点", async ({ page }) => {
  await mockCanvasBasics(page);
  await page.route("**/api/v1/canvas-import/preview", (route) =>
    route.fulfill({
      status: 400,
      json: {
        ok: false,
        error: {
          code: "IMPORT_REFERENCE_INVALID",
          message: "没有认出有效的TapNow 标识，请检查链接或分享口令",
        },
      },
    }),
  );
  await openCanvas(page);

  await page.getByLabel("导入第三方画布").click();
  await page.getByRole("menuitem", { name: /TapNow/ }).click();
  const dialog = page.getByRole("dialog", { name: /导入 TapNow 画布/ });
  await dialog.getByLabel("粘贴 TapNow 分享链接或分享 ID").fill("随便写点什么");
  await dialog.getByRole("button", { name: "读取画布" }).click();

  await expect(dialog.getByRole("alert")).toContainText("没有认出有效的TapNow 标识");
  await expect(page.locator("[data-wc-canvas-import-summary]")).toHaveCount(0);
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(0);

  // 空输入不发请求，先在本地拦下来。
  await dialog.getByLabel("粘贴 TapNow 分享链接或分享 ID").fill("");
  await dialog.getByRole("button", { name: "读取画布" }).click();
  await expect(dialog.getByRole("alert")).toContainText("请先粘贴");
});
