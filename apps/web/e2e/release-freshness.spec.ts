import { expect, test } from "@playwright/test";

test("an open Canvas tab reloads when a newer build is available", async ({ page }) => {
  await page.addInitScript(() => {
    const count = Number(sessionStorage.getItem("wc-release-page-loads") || "0");
    sessionStorage.setItem("wc-release-page-loads", String(count + 1));
  });
  await page.route("**/canvas?__kc_release_check=*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta name="weftcanvas-build" content="newer-build"></head><body></body></html>',
    }),
  );

  await page.goto("/canvas");
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("wc-release-page-loads")))
    .toBe("1");
  const reload = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await reload;
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("wc-release-page-loads")))
    .toBe("2");
});
