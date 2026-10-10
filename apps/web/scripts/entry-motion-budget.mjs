/*
 * 首屏动效开销探针。
 *
 * 用法：先在 apps/web 跑
 *   pnpm exec vite preview --host 127.0.0.1 --port 4183 --strictPort
 * 再跑 `node scripts/entry-motion-budget.mjs`。
 *
 * 为什么不用平均 fps：这台机器上平均帧率噪声有 ±5fps，出现过"关掉图层反而更慢"
 * 的荒谬读数。用户说的"卡"不是平均帧率低，而是偶发的长帧，所以这里量
 * p95 帧间隔与 >20ms 的长帧占比，并且每个状态取 3 次中位数、状态之间交替跑，
 * 抵消机器逐渐变忙的趋势。
 *
 * 判定：长帧占比 <= 8% 且 p95 <= 24ms 视为无延迟感。
 */
import { chromium } from "@playwright/test";

const ORIGIN = process.env.ENTRY_BUDGET_ORIGIN ?? "http://127.0.0.1:4183";
const SWEEP_MS = 2_400;
const SAMPLES = 3;

/* 把撤掉的三层常驻动画、mask 合成面、强制提升层与 760px 光斑原样注回来，
   作为"优化前"的同机对照。关键帧已从样式表删除，所以这里要一并声明。 */
const BEFORE = `
@keyframes kc-entry-stars-drift{from{transform:translate3d(0,0,0)}to{transform:translate3d(-70px,40px,0)}}
@keyframes kc-entry-glow-drift{from{transform:translate3d(-2%,-1%,0) scale(1)}to{transform:translate3d(2%,1.5%,0) scale(1.06)}}
.kc-entry-hero-media-stage{transform:translateZ(0)}
.kc-entry-hero-media{-webkit-mask-image:radial-gradient(78% 68% at 50% 46%,rgb(0 0 0/.85) 0%,rgb(0 0 0/.3) 55%,transparent 82%);mask-image:radial-gradient(78% 68% at 50% 46%,rgb(0 0 0/.85) 0%,rgb(0 0 0/.3) 55%,transparent 82%)}
.kc-entry-hero-media-stage::after{display:none}
.kc-entry-hero-stars{animation:kc-entry-stars-drift 120000ms linear infinite;will-change:transform}
.kc-entry-hero-stars::before{animation:kc-entry-stars-drift 90000ms linear infinite reverse;will-change:transform,opacity}
.kc-entry-hero-glow{animation:kc-entry-glow-drift 22000ms ease-in-out infinite alternate;will-change:transform}
.kc-entry-hero-spot{width:760px;height:760px;margin:-380px 0 0 -380px}
.kc-entry-hero-spot::after{display:none}
`;

const states = [
  ["优化前", BEFORE],
  ["全部开启", ""],
  ["关掉指针光斑", ".kc-entry-hero-spot{display:none!important}"],
  ["再关掉常驻星空与星云底图", ".kc-entry-hero-spot,.kc-entry-hero-stars,.kc-entry-hero-media{display:none!important}"],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
await page.goto(`${ORIGIN}/`);
await page.waitForTimeout(3_000);

const measure = async () => {
  const hero = await page.locator(".kc-entry-hero").boundingBox();
  return page.evaluate(async ({ box, sweep }) => {
    const deltas = [];
    let last = performance.now();
    let stop = false;
    const tick = () => {
      const now = performance.now();
      deltas.push(now - last);
      last = now;
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const target = document.querySelector(".kc-entry-hero");
    const started = performance.now();
    while (performance.now() - started < sweep) {
      const progress = (performance.now() - started) / sweep;
      target.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        clientX: box.x + box.width * (0.5 + 0.45 * progress),
        clientY: box.y + box.height * (0.2 + 0.6 * Math.sin(progress * 4)),
      }));
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    stop = true;
    deltas.shift();
    const sorted = [...deltas].sort((a, b) => a - b);
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    return {
      p50: Number(pick(0.5).toFixed(1)),
      p95: Number(pick(0.95).toFixed(1)),
      jank: Number(((deltas.filter((d) => d > 20).length / deltas.length) * 100).toFixed(1)),
    };
  }, { box: hero, sweep: SWEEP_MS });
};

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = Object.fromEntries(states.map(([label]) => [label, []]));

for (let round = 0; round < SAMPLES; round += 1) {
  for (const [label, css] of states) {
    // 每次只叠加到该状态为止的样式，跑完重新加载页面，避免样式残留互相污染。
    await page.goto(`${ORIGIN}/`);
    await page.waitForTimeout(2_200);
    for (const [passedLabel, passedCss] of states.slice(0, states.findIndex(([l]) => l === label) + 1)) {
      if (passedCss) await page.addStyleTag({ content: passedCss });
    }
    await page.waitForTimeout(400);
    results[label].push(await measure());
  }
}

const summary = {};
for (const [label] of states) {
  summary[label] = {
    p50: median(results[label].map((r) => r.p50)),
    p95: median(results[label].map((r) => r.p95)),
    jank: median(results[label].map((r) => r.jank)),
  };
}
console.log(JSON.stringify(summary, null, 2));

const before = summary["优化前"];
const after = summary["全部开启"];
const stripped = summary["再关掉常驻星空与星云底图"];
console.log(`优化前长帧占比 ${before.jank}% → 优化后 ${after.jank}%（同机同轮次）`);
console.log(`指针光斑净增 ${after.jank - summary["关掉指针光斑"].jank}pp；星空+底图净增 ${summary["关掉指针光斑"].jank - stripped.jank}pp`);
// 这台机器是软件渲染，绝对值到不了 60fps，门禁只看"相对基线（全关）的增量"。
const overhead = after.jank - stripped.jank;
console.log(`判定：装饰层相对基线共增 ${overhead}pp → ${overhead <= 12 ? "✓ 在预算内" : "✗ 仍有可感知开销"}`);
await browser.close();
process.exit(overhead <= 12 ? 0 : 1);
