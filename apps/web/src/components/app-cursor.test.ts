import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// 光标每帧移动；箭头自带 filter，若不钉在独立合成层上，Chromium 会按层化
// 决策反复重栅格化滤镜面，实测同一份代码在 88fps 与 6fps（p90 651ms）之间
// 反复横跳。这条断言守的是"别在清理 CSS 时把这条提升规则当无用提示删掉"。
const CURSOR_CSS = readFileSync(fileURLToPath(new URL("../app-cursor.css", import.meta.url)), "utf8");

function ruleBody(selector: string) {
  const index = CURSOR_CSS.indexOf(selector);
  if (index < 0) throw new Error(`missing rule: ${selector}`);
  const open = CURSOR_CSS.indexOf("{", index);
  const close = CURSOR_CSS.indexOf("}", open);
  return CURSOR_CSS.slice(open + 1, close);
}

describe("custom cursor compositing", () => {
  it("keeps the filtered arrow on its own compositing layer", () => {
    const arrow = ruleBody(".kc-app-cursor-arrow {");
    expect(arrow).toContain("filter: drop-shadow(");
    expect(arrow).toContain("will-change: transform");
  });

  it("promotes the pointer element that carries the per-frame transform", () => {
    expect(ruleBody(".kc-app-cursor-pointer {")).toContain("will-change: transform");
  });

  // 根节点曾经铺满视口（inset:0 + opacity 过渡），等于常驻一整屏的合成层，
  // 而实际只有几十像素在动。守着它别再长回来。
  it("keeps the cursor root out of the viewport-sized layer budget", () => {
    const root = ruleBody(".kc-app-cursor {");
    expect(root).not.toContain("inset: 0");
    expect(root).toMatch(/width:\s*0/);
    expect(root).toMatch(/height:\s*0/);
  });
});
