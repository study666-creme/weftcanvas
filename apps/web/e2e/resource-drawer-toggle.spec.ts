import { expect, test } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";

const session = {
  user: {
    id: "77777777-7777-4777-8777-777777777777",
    email: "creator@example.com",
    displayName: "创作者",
    createdAt: "2026-07-22T00:00:00.000Z",
  },
  expiresAt: "2099-08-22T00:00:00.000Z",
};

/**
 * 回归：点「卡片与资产」没反应。
 *
 * 面板是懒加载分包，首次点击到面板出现之间有一段加载时间且当时没有任何反馈，
 * 用户会以为没点上而再点一次；原来的纯 toggle 会把第二下当成关闭，面板于是
 * 永远打不开。这里锁定两条：快速重复点击仍然保持打开；面板可见后的点击仍然正常关闭。
 */
test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/v1\/.*/, (route) => route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ ok: false, error: { code: "MOCK_NOT_FOUND", message: "not mocked" } }),
  }));
  await mockAuthenticatedBackgroundApis(page);
  await page.route(/\/api\/v1\/auth\/session(?:\?.*)?$/, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      data: session,
      capabilities: { available: true, registration: "disabled", registrationUrl: null, passwordResetUrl: null, devTestAccount: false },
    }),
  }));
});

test("card library opens on a single click, and survives an impatient second click", async ({ page }) => {
  await page.goto("/canvas");

  const dock = page.getByRole("navigation", { name: "编辑工具" });
  const drawer = page.getByRole("dialog", { name: "资源库" });
  const toggle = () => dock.locator(".kc-resource-toggle").first();
  await expect(dock).toBeVisible({ timeout: 25_000 });

  // 单击即可打开
  await toggle().click();
  await expect(drawer).toBeVisible();
  expect(await toggle().getAttribute("aria-pressed")).toBe("true");

  // 关闭（面板已显示超过系统双击阈值，点击仍然是正常 toggle）
  await page.waitForTimeout(700);
  await toggle().click();
  await expect(drawer).toHaveCount(0);

  // 核心回归：用户"点一下没反应、紧接着又点一下"，面板必须仍然是打开的
  await toggle().click();
  await page.waitForTimeout(150);
  await toggle().click({ force: true });
  await expect(drawer, "第二次快速点击不应该把面板关掉").toBeVisible();
  expect(await toggle().getAttribute("aria-pressed")).toBe("true");
});
