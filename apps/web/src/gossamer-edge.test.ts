import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 游丝（gossamer）线形档的三条不变量。都是"下次改 CSS 时最容易悄悄退回去"的
 * 类型，所以用读文件的方式钉住，而不是靠人眼复检：
 *   ①换肤必须只在自己的档位属性下生效——否则一根线的改动会串到其它线形档；
 *   ②它是画布专属样式，必须留在工作台样式链，不进登录首屏（见 css-chunking.test.ts）；
 *   ③这根丝的自我约束是"无光"：不投影、不模糊，且不能吃掉拖线时的落点反馈。
 */
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const WORKBENCH_STYLES = read("./workbench-styles.css");
const MAIN = read("./main.tsx");

const SCOPE = '[data-edge-path-style="gossamer"]';

/** 去掉注释后的样式正文——下面的断言只看真正生效的声明。 */
function codeOf(relative: string): string {
  return read(relative).replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 样式文件里每一条规则的选择器头。 */
function selectorsOf(css: string): string[] {
  return css
    .split("{")
    .slice(0, -1)
    .map((chunk) => chunk.slice(chunk.lastIndexOf("}") + 1).trim())
    .filter(Boolean);
}

describe("游丝线形档", () => {
  const code = codeOf("./gossamer-edge.css");

  it("每条规则都挂在自己的档位属性下", () => {
    const selectors = selectorsOf(code);
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector).toContain(SCOPE);
    }
  });

  it("留在工作台样式链，登录首屏不下载", () => {
    expect(WORKBENCH_STYLES).toMatch(/@import\s+["']\.\/gossamer-edge\.css["']/);
    expect(MAIN).not.toContain("gossamer-edge.css");
  });

  it("不发光的自我约束：没有投影与模糊", () => {
    expect(code).not.toMatch(/drop-shadow|blur\(/);
  });

  it("换肤后拖线的落点反馈仍然存活（颜色沿用 success，只收细）", () => {
    const validSection = code.slice(code.indexOf(".is-valid"));
    expect(validSection).toContain("wc-connection-preview-base");
    expect(validSection).toContain("var(--wc-success)");
    // 2.2 是默认档的粗细；游丝里必须更细，但不能细到看不见反馈。
    expect(validSection).toMatch(/stroke-width:\s*1\.6/);
  });
});
