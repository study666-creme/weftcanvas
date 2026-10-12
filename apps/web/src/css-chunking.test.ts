import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 入口 CSS 与工作台 CSS 的分层契约。
 *
 * 登录/游客首屏与画布/生成台共用一批全局样式（tokens、壳层、对话框、toast），
 * 但画布节点、主题、光标、特效等只在工作台出现。这些样式一旦被写回入口样式表，
 * 它们就会跟着首屏一起下载——国内弱网下这正是首屏变慢的主因，而且没有任何
 * 报错会提示。所以用读文件的方式钉住分层，而不是靠人眼复检。
 */
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const MAIN = read("./main.tsx");
const CANVAS_ROUTE = read("./components/canvas-route.tsx");
const GENERATE_PAGE = read("./components/direct-generation-page.tsx");
const WORKBENCH_STYLES = read("./workbench-styles.css");

describe("CSS 分包契约", () => {
  it("入口只引入首屏需要的样式表", () => {
    const imports = [...MAIN.matchAll(/import\s+["']\.\/([\w.-]+\.css)["']/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(
      ["canvas-entry-loader.css", "entry-gate.css", "styles.css", "ui-polish.css"].sort(),
    );
  });

  it("画布与生成台都加载工作台样式，且工作台样式不进入口", () => {
    expect(CANVAS_ROUTE).toMatch(/import\s+["']\.\.\/workbench-styles\.css["']/);
    expect(GENERATE_PAGE).toMatch(/import\s+["']\.\.\/workbench-styles\.css["']/);
    expect(WORKBENCH_STYLES).toMatch(/@import\s+["']\.\/styles-workbench\.css["']/);
  });

  it("xyflow 基础样式只由画布路由引入", () => {
    expect(MAIN).not.toMatch(/@xyflow\/react\/dist\/style\.css/);
    expect(CANVAS_ROUTE).toMatch(/import\s+["']@xyflow\/react\/dist\/style\.css["']/);
  });

  it("画布专属样式块留在工作台样式表里，没有被挪回入口", () => {
    // 这些类只服务工作台（导演台命令条、视频控件、生成历史行、项目侧栏），
    // 落地页不渲染它们——是拆分后最容易被顺手写回 styles.css 的一批。
    // 注意 .wc-node-surface 之类不算：入口首屏的节点预览也在用，属于共用样式。
    const workbench = read("./styles-workbench.css");
    const entry = read("./styles.css");
    for (const selector of [
      ".wc-director-command",
      ".wc-video-controls",
      ".wc-generation-history-row",
    ]) {
      expect(workbench).toContain(selector);
      expect(entry).not.toContain(selector);
    }
  });
});
