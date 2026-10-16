import { expect, test, type Page } from "@playwright/test";

import { skipOnboardingTour } from "./onboarding.fixture";

/**
 * 站点公告弹窗：内容渲染、两种关闭语义、以及与新手教程不同时抢画面。
 *
 * 公告接口在 e2e 里一律 mock（本机 dev server 没有 API）；画布前端对公告
 * 拉取失败是静默忽略，所以只有显式 mock 的用例才会出现弹窗。
 */

const MODAL = ".wc-notice-panel";
const SCRIM = ".wc-notice-scrim";

const WEEK_AGO = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

const ANNOUNCEMENTS = {
  ok: true,
  data: {
    items: [
      {
        id: "open-source",
        title: "开源说明",
        body: "**纬线画布已经开源**：无限画布 + 多模态节点。\n\n源码全部开源，欢迎加 QQ 群 743378399 一起讨论～\n\n[去仓库看看](https://github.com/study666-creme/weftcanvas)",
        level: "important",
        pinned: true,
        publishedAt: WEEK_AGO,
      },
      {
        id: "daily-note",
        title: "服务提醒",
        body: "今晚 23:00 例行维护。",
        level: "info",
        pinned: false,
        publishedAt: YESTERDAY,
      },
    ],
  },
};

async function mockAnnouncements(page: Page) {
  await page.route("**/api/v1/announcements", (route) => route.fulfill({ json: ANNOUNCEMENTS }));
}

async function mockSignedInSession(page: Page) {
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
          version: "announcements-e2e",
          capabilityVersion: "announcements-e2e",
          pricingVersion: "announcements-e2e",
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

test("shows the announcements modal with badges, links and both dismissal buttons", async ({
  page,
}, testInfo) => {
  await skipOnboardingTour(page);
  await mockSignedInSession(page);
  await mockAnnouncements(page);
  await page.goto("/");

  const modal = page.locator(MODAL);
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("系统公告");
  await expect(modal).toContainText("2 条当前公告");
  await expect(modal).toContainText("开源说明");
  await expect(modal).toContainText("重要通知");
  await expect(modal).toContainText("置顶");
  await expect(modal).toContainText("纬线画布已经开源");
  // 相对时间 + 绝对时间（图一的信息形态）。
  await expect(modal).toContainText("周前");
  await expect(modal.locator(".wc-notice-link-row a")).toHaveAttribute(
    "href",
    "https://github.com/study666-creme/weftcanvas",
  );
  await expect(modal.getByRole("button", { name: "今日不再提醒" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("announcements-modal.png") });

  // 关闭本次：本轮收起，同一会话刷新仍不出现。
  await modal.getByRole("button", { name: "关闭本次" }).click();
  await expect(page.locator(SCRIM)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".wc-entry-gate")).toBeVisible();
  await expect(page.locator(SCRIM)).toHaveCount(0);
});

test("今日不再提醒 keeps the quiet state across reloads", async ({ page }) => {
  await skipOnboardingTour(page);
  await mockSignedInSession(page);
  await mockAnnouncements(page);
  await page.goto("/");

  const modal = page.locator(MODAL);
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "今日不再提醒" }).click();
  await expect(page.locator(SCRIM)).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".wc-entry-gate")).toBeVisible();
  await expect(page.locator(SCRIM)).toHaveCount(0);
});

test("the modal waits for the onboarding tour instead of stacking on top of it", async ({
  page,
}, testInfo) => {
  await mockSignedInSession(page);
  await mockAnnouncements(page);
  await page.goto("/");

  // 首次访客：教程先走，公告弹窗让位。
  const tourCard = page.locator(".wc-tour-card");
  await expect(tourCard).toBeVisible();
  await expect(page.locator(SCRIM)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("announcements-defer-to-tour.png") });

  // 收起教程后公告补上，两块浮层不叠在一起。
  await tourCard.getByRole("button", { name: "跳过", exact: true }).click();
  await expect(page.locator(MODAL)).toBeVisible();
});
