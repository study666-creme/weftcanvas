import { chromium } from "@playwright/test";

/**
 * 首屏闸门验收（需要 apps/web 的 dev server 在跑，默认 127.0.0.1:4173）：
 * 闸门保留、凭据不再必需、/canvas 对匿名访客开放，而 /generate/* 仍要账号。
 * 换地址：CANVAS_WEB_URL=http://127.0.0.1:5173 node scripts/verify-auth-gate.mjs
 */
const BASE = process.env.CANVAS_WEB_URL ?? "http://127.0.0.1:4173";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

const screenVisible = () =>
  page.evaluate(() => {
    const el = document.querySelector(".wc-auth-screen");
    return !!el && getComputedStyle(el).display !== "none";
  });
const visible = (selector) =>
  page
    .locator(selector)
    .isVisible()
    .catch(() => false);

// a) 全新访客落到首页 → 「开启创作」闸门自动显示，账号表单默认收起
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const gateShown = await screenVisible();
const startShown = await visible(".wc-auth-start .wc-auth-submit");
const formHidden = !(await visible("#wc-auth-email"));

// b) 「已有账号」展开表单，「返回」收起
await page
  .locator(".wc-auth-start-login")
  .first()
  .click()
  .catch(() => {});
await page.waitForTimeout(400);
const formShown = await visible("#wc-auth-email");
await page
  .getByRole("button", { name: /返回「开启创作」/ })
  .click()
  .catch(() => {});
await page.waitForTimeout(300);
const backToStart = await visible(".wc-auth-start .wc-auth-submit");

// c) 点「开启创作」→ 直接进画布，无需凭据
await page
  .locator(".wc-auth-start .wc-auth-submit")
  .click()
  .catch(() => {});
await page.waitForTimeout(1500);
const enteredPath = await page.evaluate(() => location.pathname);

// d) 匿名直达 /canvas → 不再弹回首页
await page.goto(`${BASE}/canvas`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1800);
const canvasPath = await page.evaluate(() => location.pathname);

// e) 匿名直达 /generate/video → 仍弹回首页并打开账号层
await page.goto(`${BASE}/generate/video`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2200);
const directBounce = await page.evaluate(() => location.pathname);

console.log(
  "gate:",
  JSON.stringify({
    gateShown,
    startShown,
    formHidden,
    formShown,
    backToStart,
    enteredPath,
    canvasPath,
    directBounce,
  }),
);
console.log("errors:", errors.length ? errors.join(" | ").slice(0, 260) : "none");
await browser.close();
