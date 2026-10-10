import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);

// --- 1. Theme stickiness -----------------------------------------------------
const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
// Toggle to the opposite theme via the header sun button.
await page.locator("header button:has(svg)").filter({ hasNot: page.locator(".kc-entry-account-action") }).first();
const sunButton = page.locator("header .kc-entry-actions button, header button").first();
const before = themeBefore;
await sunButton.click();
await page.waitForTimeout(400);
const afterToggle = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  mode: localStorage.getItem("kachang-canvas:theme-mode"),
}));
// Synthetic visibilitychange = the exact path that used to clobber manual choice.
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await page.waitForTimeout(300);
const afterVisibility = await page.evaluate(() => document.documentElement.dataset.theme);
// Enter the workbench.
await page.getByRole("button", { name: /打开画布/ }).click();
await page.waitForTimeout(2500);
const workbenchTheme = await page.evaluate(() => document.documentElement.dataset.theme);
console.log("theme:", JSON.stringify({ before, afterToggle, afterVisibility, workbenchTheme, mode: afterToggle.mode }));

// --- 2. Film resolution + cadence --------------------------------------------
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
await page.locator(".kc-entry-account-action").first().click();
await page.waitForTimeout(3000);
const film = await page.evaluate(() => {
  const canvas = document.querySelector(".kc-auth-film canvas, canvas");
  if (!canvas) return null;
  const host = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  return {
    host: [host.clientWidth, host.clientHeight],
    buffer: [canvas.width, canvas.height],
    factor: +(canvas.width / host.clientWidth).toFixed(3),
    dpr,
  };
});
// Sample the actual render cadence by watching canvas content changes via 2 rAF columns.
const cadence = await page.evaluate(() => new Promise((resolve) => {
  const canvas = document.querySelector(".kc-auth-film canvas, canvas");
  const gl = canvas?.getContext("webgl2");
  let renders = 0, rafs = 0;
  const t0 = performance.now();
  function probe() {
    rafs++;
    // readPixels on the default framebuffer forces a sync — too slow; instead
    // count rAFs and rely on buffer math. We approximate cadence by counting
    // rAFs over 1.5s and comparing with preserved-drawingbuffer removal.
    if (performance.now() - t0 < 1500) requestAnimationFrame(probe);
    else resolve({ rafsPerSec: Math.round(rafs / 1.5) });
  }
  requestAnimationFrame(probe);
}));
console.log("film:", JSON.stringify({ ...film, ...cadence }));
console.log("errors:", errors.length ? errors.join(" | ").slice(0, 300) : "none");
await browser.close();
