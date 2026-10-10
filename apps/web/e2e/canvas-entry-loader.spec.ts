import { expect, test } from "@playwright/test";

test("the HTML response paints a dark startup screen before JavaScript runs", async ({ page }) => {
  await page.route("**/src/main.tsx", (route) => route.abort());
  await page.goto("/canvas");

  const bootstrap = page.locator(".kc-bootstrap-screen");
  await expect(bootstrap).toBeVisible();
  await expect(bootstrap.getByRole("progressbar", { name: "画布启动进度" })).toBeVisible();
  await expect(bootstrap.getByRole("heading", { name: "正在打开画布" })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(255, 255, 255)");
});

test("restricted browser storage cannot leave the canvas on a blank screen", async ({ page }) => {
  await page.addInitScript(() => {
    const deny = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
    Object.defineProperty(Storage.prototype, "getItem", { configurable: true, value: deny });
    Object.defineProperty(Storage.prototype, "setItem", { configurable: true, value: deny });
  });

  await page.goto("/canvas");
  await expect(page.locator(".kc-workspace")).toBeVisible({ timeout: 6_000 });
  await expect(page.locator(".kc-startup-error")).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(255, 255, 255)");
});

test("a failed workspace chunk shows a recoverable startup state", async ({ page }) => {
  await page.route("**/src/components/canvas-workspace.tsx", (route) => route.abort());
  await page.goto("/canvas");

  const startupError = page.locator(".kc-startup-error");
  await expect(startupError).toBeVisible();
  await expect(startupError.getByRole("button", { name: "重新载入" })).toBeVisible();
});

for (const { name, viewport } of [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
]) {
  test(`canvas entry loader is composed and short on ${name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/canvas");

    const loader = page.locator(".kc-canvas-entry-loader");
    await expect(loader).toBeVisible();
    const visibleAt = Date.now();
    await expect(loader.getByRole("progressbar", { name: "画布进入进度" })).toBeVisible();

    const dimensions = await loader.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
    expect(dimensions.scrollHeight).toBe(dimensions.clientHeight);

    const title = loader.locator("h1");
    const progress = loader.getByRole("progressbar");
    const titleBox = await title.boundingBox();
    const progressBox = await progress.boundingBox();
    expect(titleBox).not.toBeNull();
    expect(progressBox).not.toBeNull();
    expect(titleBox!.y + titleBox!.height).toBeLessThan(progressBox!.y);

    await page.screenshot({ path: testInfo.outputPath(`canvas-entry-loader-${name}.png`) });
    await expect(loader).toHaveCount(0, { timeout: 4_000 });
    const visibleDurationMs = Date.now() - visibleAt;
    expect(visibleDurationMs).toBeGreaterThanOrEqual(350);
    expect(visibleDurationMs).toBeLessThan(3_500);
    await expect(page.locator(".kc-workspace")).toBeVisible();
    await expect(page.locator(".kc-app")).not.toHaveClass(/kc-app--canvas-loading/);
  });
}
