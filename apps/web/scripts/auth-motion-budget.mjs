/*
 * 登录页（沉浸电影引擎 + 自绘光标）性能探针。
 *
 * 用法：先在 apps/web 跑
 *   pnpm exec vite preview --host 127.0.0.1 --port 4174 --strictPort
 * 再跑 `node scripts/auth-motion-budget.mjs`（默认打 4174，可用 AUTH_BUDGET_ORIGIN 覆盖）。
 *
 * 两个必须遵守的测量前提，否则读数会骗人：
 *
 * 1. 有头 Chromium + 焦点模拟。headless shell 走 SwiftShader 软件渲染，测不出
 *    真机 GPU 的瓶颈；而有头窗口一旦失焦，电影引擎的 playing 会置 false，读数
 *    会退化成"关掉电影"的漂亮假象。用 CDP 的 Emulation.setFocusEmulationEnabled
 *    让页面保持"已聚焦"。
 * 2. 交替跑各状态、取中位数。同一台机器连续跑同一状态，p90 能从 12ms 漂到
 *    45ms，单次读数没有意义（见 entry-motion-budget.mjs 的同类说明）。
 *
 * 判定：登录页允许电影常驻，但长帧占比应接近"关掉电影"的基线——电影与自绘
 * 光标都不该让人感到延迟。
 */
import { chromium } from "@playwright/test";

const ORIGIN = process.env.AUTH_BUDGET_ORIGIN ?? "http://127.0.0.1:4174";
const SWEEP_MS = 2_400;
const ROUNDS = Number(process.env.AUTH_BUDGET_ROUNDS ?? 3);

/* 页面内采样：一边持续派发指针移动，一边量 rAF 间隔。 */
const MEASURE = ({ sweep }) => new Promise((resolve) => {
  const deltas = [];
  let last = performance.now();
  const startedAt = last;
  let stop = false;
  const tick = () => {
    const now = performance.now();
    deltas.push(now - last);
    last = now;
    if (!stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const wiggle = setInterval(() => {
    window.dispatchEvent(new PointerEvent("pointermove", {
      clientX: 300 + Math.random() * 700, clientY: 200 + Math.random() * 400,
      bubbles: true, pointerType: "mouse",
    }));
  }, 16);
  setTimeout(() => {
    stop = true;
    clearInterval(wiggle);
    deltas.shift();
    const sorted = [...deltas].sort((a, b) => a - b);
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    resolve({
      p50: Number(pick(0.5).toFixed(1)),
      p90: Number(pick(0.9).toFixed(1)),
      p95: Number(pick(0.95).toFixed(1)),
      jank: Number(((deltas.filter((d) => d > 33).length / Math.max(1, deltas.length)) * 100).toFixed(1)),
    });
  }, sweep);
});

const STATES = [
  ["电影 + 自绘光标（线上形态）", ""],
  ["关掉电影", ".kc-auth-film{display:none!important}"],
  ["关掉电影与自绘光标", ".kc-auth-film{display:none!important}.kc-app-cursor{display:none!important}.has-kc-cursor,.has-kc-cursor *{cursor:auto!important}"],
];

const browser = await chromium.launch({ headless: false, args: ["--window-position=0,0"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));

const results = Object.fromEntries(STATES.map(([label]) => [label, []]));
for (let round = 0; round < ROUNDS; round += 1) {
  for (const [label, css] of STATES) {
    await page.goto(`${ORIGIN}/`);
    await page.waitForSelector("#kc-auth-email", { timeout: 20_000 });
    // 等画质自适应收敛：电影起步会先在满档上量一次，立刻读数是启动瞬态。
    await page.waitForTimeout(5_000);
    const tag = css ? await page.addStyleTag({ content: css }) : null;
    await page.waitForTimeout(400);
    const sample = await page.evaluate(MEASURE, { sweep: SWEEP_MS });
    const film = await page.evaluate(() => {
      const c = document.querySelector("canvas.kc-auth-film");
      return c ? [c.width, c.height] : null;
    });
    results[label].push({ ...sample, film });
    if (tag) await tag.evaluate((element) => element.remove());
  }
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = {};
for (const [label] of STATES) {
  const rows = results[label];
  summary[label] = {
    p50: median(rows.map((r) => r.p50)),
    p90: median(rows.map((r) => r.p90)),
    p95: median(rows.map((r) => r.p95)),
    jank: median(rows.map((r) => r.jank)),
    filmBuffer: rows.at(-1)?.film ?? null,
  };
}
console.log(JSON.stringify(summary, null, 2));

const online = summary["电影 + 自绘光标（线上形态）"];
const baseline = summary["关掉电影与自绘光标"];
console.log(`线上形态长帧占比 ${online.jank}%，全关基线 ${baseline.jank}%；p90 ${online.p90}ms vs ${baseline.p90}ms`);
const overhead = Number((online.jank - baseline.jank).toFixed(1));
console.log(`判定：${overhead <= 8 ? "✓ 装饰层在预算内" : "✗ 仍有可感知开销"}`);
await browser.close();
process.exit(overhead <= 8 ? 0 : 1);
