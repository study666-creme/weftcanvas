import { expect, type Page } from "@playwright/test";

/**
 * `/canvas` 不再要求登录（匿名访客走本地项目 + BYOK），所以规格测试不再必须
 * 伪造会话。需要验证"登录后的云端行为"（云项目、钱包、会员）的规格仍然用这个
 * 伪造会话，把 session 探针答成真实用户。
 */
export const authenticatedSession = {
  user: {
    id: "99999999-9999-4999-8999-999999999999",
    email: "creator@example.com",
    displayName: "创作者",
    createdAt: "2026-07-16T12:00:00.000Z",
  },
  expiresAt: "2026-08-16T12:00:00.000Z",
} as const;

export async function mockAuthenticatedSession(page: Page) {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: { ok: true, data: authenticatedSession },
    }),
  );
}

/**
 * The create rail keeps its node types in a popover that is only hit-testable
 * while the "+" trigger is hovered (`.wc-create-rail-plus-wrapper:hover`), so a
 * direct click on a menu item is intercepted by the canvas pane. Opening the
 * popover first and then clicking the item through the mouse also avoids the
 * actionability retry loop: the item shifts 0.5px on its own hover transform,
 * which Playwright reports as an unstable element forever.
 */
export async function addCanvasNode(page: Page, name: string) {
  const rail = page.getByRole("navigation", { name: "创建工具" });
  await rail.getByLabel("添加节点").hover();
  // The items carry role="menuitem", so match them by their aria-label.
  const item = rail.getByLabel(name);
  await expect(item).toBeVisible();
  const box = await item.boundingBox();
  if (!box) throw new Error(`创建工具 面板里的「${name}」没有可点击区域`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}
