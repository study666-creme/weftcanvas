import { expect, type Page } from "@playwright/test";

import { seedStarterCanvas } from "./starter-canvas.fixture";
import { test } from "./zero-cost-test";

/**
 * 设置中心「界面」两个页签里，每一组偏好选项必须排成**一行**。
 *
 * 为什么钉这条：档位是开放注册的（外观包、插件都能往槽位里加），而每组的列数写在
 * appearance-panel.css 的 --* 规则里。列数写死 + 选项变多 = 多出来的那一个掉到第二行，
 * 变成孤零零的一格——「生成」四张预览卡挤成 3+1、加完「游丝」后线形挤成 4+1 都是这一类。
 * 这种退化不会报错，只会在设置面板里留下难看的空缺，所以用几何量一次。
 */
type GroupRow = { label: string; rows: number; buttons: number };

async function groupRows(page: Page): Promise<GroupRow[]> {
  return page.$$eval(".wc-ui-settings-panel:not([hidden]) .wc-appearance-segmented", (groups) =>
    groups.map((group) => {
      const tops = new Set(
        [...group.querySelectorAll(":scope > button")].map((button) =>
          Math.round(button.getBoundingClientRect().top),
        ),
      );
      return {
        label: group.getAttribute("aria-label") ?? "(无名)",
        rows: tops.size,
        buttons: group.querySelectorAll(":scope > button").length,
      };
    }),
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
  await page
    .locator(".wc-canvas-entry-loader")
    .waitFor({ state: "attached", timeout: 3_000 })
    .catch(() => {});
  await expect(page.locator(".wc-canvas-entry-loader")).toHaveCount(0, { timeout: 15_000 });

  const dock = page.getByRole("navigation", { name: "编辑工具" });
  await dock.getByLabel("打开界面设置").click();
  await expect(page.getByRole("dialog", { name: "界面设置" })).toBeVisible();
});

test("界面页签的每一组偏好都排成一行", async ({ page }) => {
  const settings = page.getByRole("dialog", { name: "界面设置" });
  await settings.getByRole("tab", { name: "视觉" }).click();
  await expect
    .poll(async () => (await groupRows(page)).filter((group) => group.rows > 1))
    .toEqual([]);
  const visual = await groupRows(page);
  expect(visual.length).toBeGreaterThanOrEqual(6);
  // 生成动效四张卡：断言它确实是一行四格，而不是"看起来没折行"。
  expect(visual.find((group) => group.label === "生成动效")).toMatchObject({
    rows: 1,
    buttons: 4,
  });

  await settings.getByRole("tab", { name: "交互" }).click();
  await expect
    .poll(async () => (await groupRows(page)).filter((group) => group.rows > 1))
    .toEqual([]);
  const interaction = await groupRows(page);
  expect(interaction.find((group) => group.label === "连线形态")).toMatchObject({
    rows: 1,
    buttons: 5,
  });
});
