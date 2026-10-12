import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.goto("/canvas");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("zoom dot background can be selected, scales with the viewport, and persists", async ({
  page,
}, testInfo) => {
  const shell = page.locator(".wc-flow-shell");
  await expect(shell).toHaveAttribute("data-canvas-background", "layered-grid");
  await expect(page.getByTestId("canvas-zoom-dot-grid")).toHaveCount(0);

  await page.getByLabel("打开 UI 设置").click();
  const backgroundStyles = page.getByRole("group", { name: "背景样式" });
  await backgroundStyles.getByRole("button", { name: "点阵", exact: true }).click();

  await expect(shell).toHaveAttribute("data-canvas-background", "zoom-dots");
  const dotGrid = page.getByTestId("canvas-zoom-dot-grid");
  await expect(dotGrid).toBeVisible();
  await expect(dotGrid).toHaveCSS("background-color", "rgb(13, 13, 13)");
  expect(await dotGrid.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain(
    "radial-gradient",
  );
  await page.screenshot({ path: testInfo.outputPath("background-picker.png") });

  await page.getByLabel("收起 UI 设置").click();
  await page.waitForTimeout(240);
  await page.screenshot({ path: testInfo.outputPath("zoom-dot-grid-default.png") });
  const offsetsBeforePan = await dotGrid.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.getPropertyValue("--wc-zoom-dot-grid-x")}:${style.getPropertyValue("--wc-zoom-dot-grid-y")}`;
  });
  await page.mouse.move(1_080, 680);
  await page.mouse.wheel(43, 31);
  await expect
    .poll(() =>
      dotGrid.evaluate((element) => {
        const style = getComputedStyle(element);
        return `${style.getPropertyValue("--wc-zoom-dot-grid-x")}:${style.getPropertyValue("--wc-zoom-dot-grid-y")}`;
      }),
    )
    .not.toBe(offsetsBeforePan);

  const zoom = page.getByRole("slider", { name: "画布缩放" });
  await zoom.press("End");
  await expect(zoom).toHaveAttribute("aria-valuetext", "240%");
  await expect
    .poll(() =>
      dotGrid.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--wc-zoom-dot-grid-size").trim(),
      ),
    )
    .toBe("115.2px");
  await page.screenshot({ path: testInfo.outputPath("zoom-dot-grid-240.png") });

  await page.getByLabel("切换主题").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(dotGrid).toHaveCSS("background-color", "rgb(231, 232, 229)");
  await page.screenshot({ path: testInfo.outputPath("zoom-dot-grid-light.png") });

  await page.reload();
  await expect(shell).toHaveAttribute("data-canvas-background", "zoom-dots");
  await expect(page.getByTestId("canvas-zoom-dot-grid")).toBeVisible();
  await page.getByLabel("打开 UI 设置").click();
  await expect(
    page
      .getByRole("group", { name: "背景样式" })
      .getByRole("button", { name: "点阵", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
