import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 白天模式（light）与登录页的三条视觉不变量。都是"改 CSS 时很容易悄悄退回去"
 * 的类型，所以用读文件的方式钉住，而不是靠人眼复检。
 */
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const ENTRY_GATE = read("./entry-gate.css");
const CANVAS_EFFECTS = read("./canvas-effects.css");
const AUTH_SCREEN = read("./components/auth-screen.css");

describe("白天模式背景整治", () => {
  it("首屏星空与光晕在浅色下整层关掉", () => {
    // 白点阵叠在近白底上要么看不见，要么在彩色渐晕上读作灰尘/水汽颗粒；
    // 8-14% 的大块彩雾在浅色底上同样是"发霉"的观感。
    expect(ENTRY_GATE).toMatch(
      /\.wc-app\[data-theme="light"\]\s*\.wc-entry-hero-stars[\s\S]{0,240}display:\s*none/,
    );
    expect(ENTRY_GATE).toMatch(
      /\.wc-app\[data-theme="light"\]\s*\.wc-entry-hero-glow[\s\S]{0,160}display:\s*none/,
    );
  });

  it("深色噪点纹理在浅色下不铺页", () => {
    expect(ENTRY_GATE).toMatch(
      /\.wc-app\[data-theme="light"\]\s*\.wc-entry-gate::after[\s\S]{0,200}display:\s*none/,
    );
    expect(ENTRY_GATE).toMatch(
      /\.wc-app\[data-theme="light"\]\s*\.wc-direct-page::after[\s\S]{0,200}display:\s*none/,
    );
  });

  it("画布星空/水面在浅色下有等价物，不再是硬编码的夜空底色", () => {
    const lightSection = CANVAS_EFFECTS.slice(CANVAS_EFFECTS.indexOf(':root[data-theme="light"]'));
    expect(lightSection).toContain('[data-canvas-background="starfield"]');
    expect(lightSection).toContain('[data-canvas-background="water"]');
    expect(lightSection).toContain("var(--wc-background-canvas)");
    // 浅色底上的白点阵必须关掉，否则就是"灰尘"。
    expect(lightSection).toMatch(/\.wc-canvas-starfield-layer[\s\S]{0,240}display:\s*none/);
  });
});

describe("登录页输入框", () => {
  it("autofill 就地钉死深底浅字，不继承主题令牌", () => {
    // 全局 autofill 规则用 --wc-surface-muted：白天模式那是浅色，会在深色登录页
    // 里画出一个亮白方块 + 深字——也就是"输入框还是浏览器原始框"。
    expect(AUTH_SCREEN).toMatch(
      /\.wc-auth-input-shell > input:-webkit-autofill[\s\S]{0,400}-webkit-text-fill-color/,
    );
    expect(AUTH_SCREEN).toMatch(
      /\.wc-auth-input-shell > input:-webkit-autofill[\s\S]{0,400}box-shadow:\s*0 0 0 1000px/,
    );
  });
});
