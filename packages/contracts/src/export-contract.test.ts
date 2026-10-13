import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 生产运行时只拿到编译后的产物：发布包只带 `dist` 与 `package.json`，`src` 不随包
 * 交付，Node 也不能执行依赖目录里的 TypeScript。因此每个子路径导出的**运行时**条件
 * 必须指向 `dist/*.js`——把 `default` 指回 `src/*.ts` 会让打包后的 API/Agent 启动时
 * 直接模块解析失败（2026-10-12 在发布包里实测到：某个内容库子路径解析到不存在的
 * src 文件）。
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
  exports: Record<string, string | Record<string, string>>;
};

describe("contracts 导出契约", () => {
  it("每个子路径的运行时目标都指向已构建的 dist JS", () => {
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const conditions = typeof target === "string" ? { default: target } : target;
      const runtimeTargets = Object.entries(conditions).filter(([name]) => name !== "types");
      expect(runtimeTargets.length, `${subpath} 需要运行时条件`).toBeGreaterThan(0);
      for (const [condition, value] of runtimeTargets) {
        expect(value, `${subpath} 的 ${condition} 必须指向 dist JS`).toMatch(/^\.\/dist\/.+\.js$/);
        expect(existsSync(resolve(packageRoot, value)), `${subpath} 的 ${value} 不存在`).toBe(true);
      }
    }
  });

  it("类型条件仍指向源码，保证编辑器与 tsc 走同一份定义", () => {
    for (const target of Object.values(manifest.exports)) {
      const conditions = typeof target === "string" ? { default: target } : target;
      if (conditions.types) expect(conditions.types).toMatch(/^\.\/src\/.+\.ts$/);
    }
  });
});
