import { skipOnboardingTour } from "./onboarding.fixture";
import { expect, test } from "./zero-cost-test";

/**
 * 生成类型切换器是**一行窄条**，不是三张高卡片。
 *
 * 用户 2026-10-16：「功能选项又太长了，占据屏幕，每次都要往下翻很多」。
 * 这里锁住真正会回退的东西：三个类型仍在一行（顶边齐平）、整条高度不超过 60px、
 * 各视口宽度下都不横向溢出。以前是 118px 的三张卡片，改回卡片高度就会在这里失败，
 * 而不是等用户再翻一次屏才发现。
 */
const VIEWPORTS = [
  { name: "桌面", width: 1440, height: 900 },
  { name: "笔记本", width: 1280, height: 720 },
  { name: "手机", width: 390, height: 844 },
];

test("generation type switcher stays a single slim row", async ({ page }) => {
  await skipOnboardingTour(page);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/generate/image");

    const strip = page.locator(".wc-direct-studio-tabs");
    await expect(strip).toBeVisible();
    await expect(page.getByRole("tablist", { name: "生成类型" }).getByRole("tab")).toHaveCount(3);

    const measured = await strip.evaluate((node) => {
      const buttons = [...node.querySelectorAll(".wc-direct-studio-tablist > button")];
      return {
        height: Math.round(node.getBoundingClientRect().height),
        overflow: node.scrollWidth - node.clientWidth,
        labels: buttons.map((button) => (button.textContent ?? "").trim()),
        tops: [...new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)))],
        selected: buttons
          .filter((button) => button.getAttribute("aria-selected") === "true")
          .map((button) => (button.textContent ?? "").trim()),
      };
    });

    expect(measured.labels, viewport.name).toEqual(["图片生成", "视频生成", "音频生成"]);
    expect(measured.selected, viewport.name).toEqual(["图片生成"]);
    expect(measured.tops, `${viewport.name}：三个类型必须在一行`).toHaveLength(1);
    expect(measured.height).toBeLessThanOrEqual(60);
    expect(measured.overflow, `${viewport.name}：切换条不得横向溢出`).toBeLessThanOrEqual(0);
  }
});

test("audio workbench keeps modality-correct copy instead of video placeholder", async ({
  page,
}) => {
  await skipOnboardingTour(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/generate/audio");

  await expect(page.getByRole("tab", { name: "音频生成" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("[data-direct-prompt]")).toHaveAttribute(
    "placeholder",
    "描述音乐风格与情绪，或写下要说的话……",
  );
  // 音频页曾借用视频示例卡（卡上是视频模型与成片），现在是音频专属的说明，
  // 不再出现"示例预览"的图片墙。
  await expect(page.locator(".wc-direct-sample-note")).toContainText("播放器");
  await expect(page.locator(".wc-direct-result-tile")).toHaveCount(0);
});
