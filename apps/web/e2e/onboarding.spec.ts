import { expect, test, type Page } from "@playwright/test";

import { addCanvasNode } from "./canvas-ui.fixture";

/**
 * 新手教程：首屏「去简易工作台」→ 工作台（认识工作台 → 点右上角「打开画布」）
 * → 画布上创建节点 / 空格平移 / Ctrl 缩放。
 *
 * 教程只在"从首屏首访"或"直接落在 /generate/*"这两条路上自动开跑，所以这里必须
 * 让入口门真的渲染出来（mock 一个已登录会话；匿名会话在本机会被登录优先页整个替掉）。
 */

const CARD = ".wc-tour-card";
const SPOTLIGHT = ".wc-tour-spotlight";

async function mockSignedInGate(page: Page) {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          user: {
            id: "22222222-2222-4222-8222-222222222222",
            email: "first-timer@example.com",
            displayName: "新用户",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
          expiresAt: "2099-10-01T00:00:00.000Z",
        },
      },
    }),
  );
  await page.route("**/api/v1/model-catalog**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          version: "onboarding-e2e-catalog",
          capabilityVersion: "onboarding-e2e",
          pricingVersion: "onboarding-e2e",
          fetchedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          quoteAvailable: true,
          models: [],
        },
      },
    }),
  );
  await page.route("**/api/v1/generation-jobs?*", (route) =>
    route.fulfill({ json: { ok: true, data: [] } }),
  );
}

async function canvasZoom(page: Page) {
  return page.locator(".react-flow__viewport").evaluate((element) => {
    return new DOMMatrixReadOnly(getComputedStyle(element).transform).a;
  });
}

/** 高亮环的矩形必须真的套在被教的控件上，否则教程就是在乱指。 */
async function expectSpotlightOver(page: Page, selector: string) {
  // 首屏英雄区有入场位移，两次独立的 boundingBox 之间元素会在动；这里在同一帧里
  // 同时读两个矩形，并轮询到"套住"为止，而不是拿两次快照硬比。
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ ringSelector, targetSelector }) => {
            const spotlight = document.querySelector(ringSelector);
            const target = document.querySelector(targetSelector);
            if (!spotlight || !target) return "missing";
            const ring = spotlight.getBoundingClientRect();
            const box = target.getBoundingClientRect();
            const covers =
              ring.left <= box.left + 2 &&
              ring.top <= box.top + 2 &&
              ring.right >= box.right - 2 &&
              ring.bottom >= box.bottom - 2;
            return covers
              ? "covers"
              : `ring ${Math.round(ring.left)},${Math.round(ring.top)},${Math.round(ring.right)},${Math.round(
                  ring.bottom,
                )} vs ${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.right)},${Math.round(
                  box.bottom,
                )}`;
          },
          { ringSelector: SPOTLIGHT, targetSelector: selector },
        ),
      { timeout: 6_000 },
    )
    .toBe("covers");
}

test("a first-time visitor is walked from the workbench into the canvas and through the basics", async ({
  page,
}, testInfo) => {
  await mockSignedInGate(page);
  await page.goto("/");

  const card = page.locator(CARD);

  // 首屏第一步：引导用户点顶部生成入口去简易工作台（不再从首屏直接进画布）。
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-step", "goto-workbench");
  await expect(card).toContainText("简易工作台");
  await expect(card).toContainText("1/6");
  await expectSpotlightOver(page, '[data-wc-tour="goto-workbench"]');
  await page.screenshot({ path: testInfo.outputPath("tour-1-goto-workbench.png") });

  // 用户点的是被高亮的真入口（不是卡片上的按钮）：三个生成入口都挂这个锚点，
  // 教程环套住第一个「图片生成」，这里同样点它。整页跳到工作台后，
  // 教程应当在工作台上自动接跑「认识工作台」那一步。
  await page.locator('[data-wc-tour="goto-workbench"]').first().click();
  await expect(page).toHaveURL(/\/generate\/image$/);
  await expect(card).toHaveAttribute("data-step", "workbench", { timeout: 15_000 });
  await expectSpotlightOver(page, '[data-wc-tour="workbench"]');
  await page.screenshot({ path: testInfo.outputPath("tour-2-workbench.png") });

  // 工作台第二步：指向右上角的「打开画布」。
  await card.getByRole("button", { name: "下一步" }).click();
  await expect(card).toHaveAttribute("data-step", "enter-canvas");
  await expectSpotlightOver(page, '[data-wc-tour="enter-canvas"]');
  await page.screenshot({ path: testInfo.outputPath("tour-3-enter-canvas.png") });

  // 点被高亮的真按钮：SPA 切路由（不是整页刷新），教程在画布上接着走。
  await page.locator('[data-wc-tour="enter-canvas"]').click();
  await expect(page).toHaveURL(/\/canvas$/);

  // 画布第三步：创建节点。画布入场加载层退场后才出现，所以给宽一点的等待。
  await expect(card).toHaveAttribute("data-step", "create-node", { timeout: 15_000 });
  await expectSpotlightOver(page, '[data-wc-tour="create-rail"]');
  // 跨路由（工作台 → 画布）回不去，所以这一步不提供「上一步」。
  await expect(card.getByRole("button", { name: "上一步" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("tour-4-create-node.png") });

  // 真的去创建一个节点：教程应当自己往前走。
  await addCanvasNode(page, "添加文本节点");
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(1);
  await expect(card).toHaveAttribute("data-step", "space-pan");
  await expect(card).toContainText("空格");

  // 真按住空格拖动一次：自动前进到缩放那一步。
  await page.screenshot({ path: testInfo.outputPath("tour-5-space-pan.png") });
  // 起手点刻意选在画面右侧：居中的教程卡占着视口中下方。
  await page.mouse.move(1_080, 300);
  await page.keyboard.down("Space");
  await page.mouse.down();
  await page.mouse.move(960, 380, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect(card).toHaveAttribute("data-step", "ctrl-zoom");

  // Ctrl + 滚轮：既真的缩放画布，也让教程收尾。
  await expectSpotlightOver(page, '[data-wc-tour="zoom"]');
  await page.screenshot({ path: testInfo.outputPath("tour-6-ctrl-zoom.png") });
  const before = await canvasZoom(page);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Control");
  await expect(card).toHaveCount(0);
  expect(await canvasZoom(page)).toBeGreaterThan(before);

  // 看过一次就不再自动弹：刷新后画布上不该再有教程。
  expect(await page.evaluate(() => localStorage.getItem("weftcanvas:onboarding:v1"))).toBe("done");
  await page.reload();
  await expect(page.locator(".wc-workspace")).toBeVisible();
  await expect(page.locator(CARD)).toHaveCount(0);
});

test("the tour card stays legible in the dark theme", async ({ page }, testInfo) => {
  await mockSignedInGate(page);
  // 减少动效：主题切换会走 View Transition 交叉淡化（异步提交），
  // 这里要的是确定性的换色结果；顺带也让教程卡片不做入场位移。
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const card = page.locator(CARD);
  await expect(card).toBeVisible();

  // 主题是跟着本地时间自动切换的，所以按当前状态翻到深色而不是假定起始值。
  const toggle = page.locator(".wc-entry-theme-action");
  await toggle.click();
  if ((await page.locator("html").getAttribute("data-theme")) !== "dark") await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".wc-app")).toHaveAttribute("data-theme", "dark");

  const palette = await card.evaluate((element) => {
    const cardBackground = getComputedStyle(element).backgroundColor;
    return {
      cardBackground,
      title: getComputedStyle(element.querySelector(".wc-tour-title")!).color,
      body: getComputedStyle(element.querySelector(".wc-tour-body")!).color,
      kicker: getComputedStyle(element.querySelector(".wc-tour-kicker")!).color,
    };
  });
  // 卡片底色在深色下也必须是"实底 + 文字带明确明度差"，不接受透到画布的浅灰字。
  for (const value of [palette.title, palette.body, palette.kicker]) {
    expect(value).not.toBe("rgba(0, 0, 0, 0)");
    expect(value).not.toBe(palette.cardBackground);
  }
  // color-mix 会算出 color(srgb ...) 这类新语法；只要不是全透明即可。
  expect(palette.cardBackground).not.toMatch(/\/\s*0\)$/);
  // 主题切换走 View Transition 交叉淡化，截图要等这层快照收掉。
  await page.waitForTimeout(700);
  await page.screenshot({ path: testInfo.outputPath("tour-dark-theme.png") });
  await card.screenshot({ path: testInfo.outputPath("tour-dark-theme-card.png") });
});

test("the tour can be replayed from the shortcuts panel and skipped for good", async ({
  page,
}, testInfo) => {
  await mockSignedInGate(page);
  await page.goto("/canvas");
  await expect(page.locator(".wc-workspace")).toBeVisible();

  // 直接从 /canvas 进来（不是从首屏走过来的）不会自动起教程。
  await expect(page.locator(CARD)).toHaveCount(0);

  await page.getByLabel("画布快捷键").click();
  const panel = page.getByRole("dialog", { name: "画布快捷键" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("按住平移画布");
  await expect(panel).toContainText("Ctrl");
  await panel.getByRole("button", { name: "重看新手教程" }).click();

  // 重看一律从**首屏**起步：先把人送回入口页，第一张卡是首屏那一步。
  const card = page.locator(CARD);
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-step", "goto-workbench");
  await expectSpotlightOver(page, '[data-wc-tour="goto-workbench"]');
  await page.screenshot({ path: testInfo.outputPath("tour-replay-entry.png") });

  // 这一步也走一遍卡片自己的「去简易工作台」按钮：SPA 切路由，教程跟着走到工作台。
  await card.getByRole("button", { name: "去简易工作台" }).click();
  await expect(page).toHaveURL(/\/generate\/image$/);
  await expect(card).toHaveAttribute("data-step", "workbench", { timeout: 15_000 });

  // 从工作台再走回画布：第二步的高亮环套在「打开画布」上，点它回到画布，
  // 教程接着走画布那一段。
  await card.getByRole("button", { name: "下一步" }).click();
  await expect(card).toHaveAttribute("data-step", "enter-canvas");
  await page.locator('[data-wc-tour="enter-canvas"]').click();
  await expect(page).toHaveURL(/\/canvas$/);
  await expect(card).toHaveAttribute("data-step", "create-node", { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("tour-replay-canvas.png") });

  // 关闭叉的可见名是「跳过新手教程」，所以这里精确匹配卡片底部的「跳过」。
  await card.getByRole("button", { name: "跳过", exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("weftcanvas:onboarding:v1"))).toBe("done");

  // 跳过之后不再自己回来。
  await page.reload();
  await expect(page.locator(".wc-workspace")).toBeVisible();
  await expect(page.locator(CARD)).toHaveCount(0);
});
