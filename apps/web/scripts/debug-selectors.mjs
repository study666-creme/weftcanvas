import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:5173/generate/video", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const selectors = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll("*"));
  const modelEls = all.filter(
    (el) =>
      el.className &&
      typeof el.className === "string" &&
      (el.className.includes("model") ||
        el.className.includes("select") ||
        el.className.includes("picker")),
  );
  return modelEls.slice(0, 40).map((el) => ({
    tag: el.tagName,
    classes: el.className,
    text: el.textContent?.slice(0, 60),
  }));
});

console.log(JSON.stringify(selectors, null, 2));
await browser.close();
