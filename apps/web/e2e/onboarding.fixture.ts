import type { Page } from "@playwright/test";

/**
 * 把新手教程标记成"已经看过"。
 *
 * 教程在"第一次落在首屏"时自动开跑（行为本身由 e2e/onboarding.spec.ts 覆盖），
 * 而它的高亮卡片会盖住首屏上的控件。凡是与教程无关、却要经过首屏的规格都应
 * 先调用本函数，否则测的就不是被测功能，而是卡片有没有挡住按钮。
 *
 * 必须在会 `localStorage.clear()` 的 addInitScript **之后**调用：init script 按
 * 添加顺序执行，先清后写才留得住这个标记。
 */
export async function skipOnboardingTour(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("weftcanvas:onboarding:v1", "done");
  });
}
