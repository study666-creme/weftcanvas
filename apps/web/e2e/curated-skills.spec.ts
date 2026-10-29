import { expect, test, type Page } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";
import { skipOnboardingTour } from "./onboarding.fixture";

/**
 * 技能页的「精选技能」：随产品分发的 MIT 单文件内容，只有用户点「添加」才走
 * 现有导入接口存进自己的技能库，并且不会被自动勾选。
 */
const session = {
  user: {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    email: "creator@example.com",
    displayName: "创作者",
    createdAt: "2026-07-16T12:00:00.000Z",
  },
  expiresAt: "2099-08-16T12:00:00.000Z",
} as const;

async function mockSignedInHome(page: Page) {
  await page.route(/\/api\/v1\/auth\/session(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { ok: true, data: session } }),
  );
  await page.route("**/api/v1/wallet", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          credits: 0,
          creditsPermanent: 0,
          dailyCredits: 0,
          creditGrantMode: "bundle",
          dailyCreditsNote: "",
          membership: { tier: "free", until: null, active: false, genDiscount: null },
          lifetimeCreditsSpent: 0,
        },
      },
    }),
  );
  await page.route("**/api/v1/generation-jobs?*", (route) =>
    route.fulfill({ json: { ok: true, data: [] } }),
  );
  await page.route("**/api/v1/announcements", (route) =>
    route.fulfill({ json: { ok: true, data: [] } }),
  );
  await mockAuthenticatedBackgroundApis(page);
}

test("精选技能只在点添加后进入技能库，且不会被自动启用", async ({ page }, testInfo) => {
  let library: Array<Record<string, unknown>> = [];
  let postedContent = "";

  await page.addInitScript(() => {
    // addInitScript 每次导航都会跑；只在第一次固定成墨黑，后面的手动换主题才留得住。
    if (sessionStorage.getItem("wc-curated-skills-theme-initialized")) return;
    sessionStorage.setItem("wc-curated-skills-theme-initialized", "true");
    localStorage.setItem("weftcanvas:theme-mode", "manual");
    localStorage.setItem("weftcanvas:theme", "dark");
  });
  await skipOnboardingTour(page);
  await mockSignedInHome(page);
  await page.route("**/api/v1/agent/skills", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      return route.fulfill({ json: { ok: true, data: library } });
    }
    if (method === "POST") {
      const body = route.request().postDataJSON() as { content?: string };
      postedContent = body.content ?? "";
      const name = /^---\nname:\s*(.+)$/m.exec(postedContent)?.[1]?.trim() ?? "未知技能";
      const skill = {
        id: "bbbbbbbb-1111-4111-8111-111111111111",
        name,
        description: "精选技能导入回执",
        size: postedContent.length,
        hash: "curated-hash",
        createdAt: "2026-10-27T00:00:00.000Z",
        updatedAt: "2026-10-27T00:00:00.000Z",
      };
      library = [skill, ...library];
      return route.fulfill({ status: 201, json: { ok: true, data: skill } });
    }
    return route.fulfill({ status: 405, json: { ok: false } });
  });

  await page.goto("/?tab=skills");
  await expect(page.locator(".wc-app")).toHaveAttribute("data-theme", "dark");

  const curated = page.getByRole("region", { name: "精选技能" });
  await expect(curated).toBeVisible();
  await expect(curated.locator(".wc-home-curated-item")).toHaveCount(6);
  // 内容来自固定 commit 的上游仓库，列表里要能看到出处
  await expect(curated.getByText("blader/humanizer · MIT")).toBeVisible();

  // 未添加前，技能库里没有同名技能
  await expect(page.getByLabel("本轮启用技能 文案去 AI 味")).toHaveCount(0);

  await curated.getByRole("button", { name: "添加技能 文案去 AI 味", exact: true }).click();

  await expect(
    page.getByText("已添加「文案去 AI 味」，在画布 Agent 里勾选后随下一轮对话生效"),
  ).toBeVisible();
  await expect(
    curated.getByRole("button", { name: "已添加技能 文案去 AI 味", exact: true }),
  ).toBeDisabled();
  await expect(
    curated.getByRole("button", { name: "添加技能 文案去 AI 味", exact: true }),
  ).toHaveCount(0);

  // 导入的是精选技能正文本身，并且默认不勾选
  expect(postedContent).toContain("name: 文案去 AI 味");
  expect(postedContent.length).toBeGreaterThan(1_000);
  const checkbox = page.getByLabel("本轮启用技能 文案去 AI 味");
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();

  // 行文字与底色必须来自不同令牌，不能靠低对比度伪装层级
  const colors = await curated
    .locator(".wc-home-curated-item")
    .first()
    .evaluate((element) => {
      const title = element.querySelector<HTMLElement>(".wc-home-curated-copy strong");
      const meta = element.querySelector<HTMLElement>(".wc-home-curated-copy a");
      const style = getComputedStyle(element);
      return {
        rowBackground: style.backgroundColor,
        title: title ? getComputedStyle(title).color : "",
        meta: meta ? getComputedStyle(meta).color : "",
      };
    });
  expect(colors.title).not.toBe(colors.rowBackground);
  expect(colors.meta).not.toBe(colors.rowBackground);

  await page.screenshot({ path: testInfo.outputPath("curated-skills-dark.png") });

  // 石墨（light）配色：同样的行仍然可读
  await page.evaluate(() => {
    localStorage.setItem("weftcanvas:theme-mode", "manual");
    localStorage.setItem("weftcanvas:theme", "light");
  });
  await page.reload();
  await expect(page.locator(".wc-app")).toHaveAttribute("data-theme", "light");
  const lightCurated = page.getByRole("region", { name: "精选技能" });
  await expect(lightCurated).toBeVisible();
  const lightColors = await lightCurated
    .locator(".wc-home-curated-item")
    .first()
    .evaluate((element) => {
      const title = element.querySelector<HTMLElement>(".wc-home-curated-copy strong");
      const style = getComputedStyle(element);
      return {
        rowBackground: style.backgroundColor,
        title: title ? getComputedStyle(title).color : "",
      };
    });
  expect(lightColors.title).not.toBe(lightColors.rowBackground);
  await page.screenshot({ path: testInfo.outputPath("curated-skills-light.png") });

  // 窄屏不产生横向滚动
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(lightCurated).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});
